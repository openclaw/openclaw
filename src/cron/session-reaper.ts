/**
 * Cron session reaper — prunes completed isolated cron run sessions
 * from the session store after a configurable retention period.
 *
 * Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
 * run records. The base session (`...:cron:<jobId>`) is kept as-is.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import {
  isEmbeddedPiRunActive,
  resolveActiveEmbeddedRunSessionId,
} from "../agents/pi-embedded-runner/runs.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { archiveRemovedSessionTranscripts, updateSessionStore } from "../config/sessions/store.js";
import type { CronConfig } from "../config/types.cron.js";
import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
import { isCronJobActive } from "./active-jobs.js";
import { resolveCronRunLogPath } from "./run-log.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { countActiveDescendantRuns } from "../agents/subagent-registry-read.js";
import { listTasksForRelatedSessionKey } from "../tasks/runtime-internal.js";
import type { TaskRecord, TaskStatus } from "../tasks/task-registry.types.js";
import type { CronRunStatus } from "./types.js";
import type { Logger } from "./service/state.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours
const DEFAULT_ZOMBIE_IDLE_MS = 3_600_000; // 1 hour
const CONSERVATIVE_MIN_IDLE_MS = 24 * 3_600_000; // 24 hours

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByStore = new Map<string, number>();
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["queued", "running"]);

export type CronRunSessionCleanupMode = "conservative" | "standard" | "aggressive";

type CronRunSignal = {
  sessionKey: string;
  sessionId?: string;
  jobId: string;
  status?: CronRunStatus;
  ts: number;
  runAtMs?: number;
  summary?: string;
  error?: string;
};

export type CronRunSessionCandidate = {
  sessionKey: string;
  sessionId: string;
  jobId: string;
  label?: string;
  createdAtMs?: number;
  completedAtMs?: number;
  lastActiveAtMs: number;
  idleMs: number;
  lastMessage?: string;
  activeRun: boolean;
  activeChildRuns: number;
  runStatus?: CronRunStatus;
  runCompleted: boolean;
};

type CronRunSessionSkipReason =
  | "invalid-key"
  | "missing-session-id"
  | "not-idle"
  | "active-session-run"
  | "active-run"
  | "active-task"
  | "active-child-runs"
  | "active-exec"
  | "run-not-completed"
  | "completion-signal-missing"
  | "reused"
  | "post-completion-not-idle";

type CronRunSessionSkipCounts = Record<CronRunSessionSkipReason, number>;

export type CronRunSessionScanResult = {
  scanned: number;
  candidates: CronRunSessionCandidate[];
  skipped: CronRunSessionSkipCounts;
};

type CronRunSessionKeyParts = {
  jobId: string;
  runId: string;
};

type RunSignalIndex = {
  bySessionKey: Map<string, CronRunSignal>;
};

function createSkipCounts(): CronRunSessionSkipCounts {
  return {
    "invalid-key": 0,
    "missing-session-id": 0,
    "not-idle": 0,
    "active-session-run": 0,
    "active-run": 0,
    "active-task": 0,
    "active-child-runs": 0,
    "active-exec": 0,
    "run-not-completed": 0,
    "completion-signal-missing": 0,
    reused: 0,
    "post-completion-not-idle": 0,
  };
}

function hasActiveSessionRun(params: { sessionKey: string; sessionId: string }): boolean {
  const activeSessionId = resolveActiveEmbeddedRunSessionId(params.sessionKey);
  if (typeof activeSessionId === "string" && activeSessionId.trim()) {
    return true;
  }
  return isEmbeddedPiRunActive(params.sessionId);
}

function resolveActiveRelatedTask(sessionKey: string): TaskRecord | undefined {
  return listTasksForRelatedSessionKey(sessionKey).find(
    (task) => task.scopeKind === "session" && ACTIVE_TASK_STATUSES.has(task.status),
  );
}

function hasActiveBackgroundExec(sessionKey: string): boolean {
  return listRunningSessions().some((session) => session.sessionKey?.trim() === sessionKey);
}

function parseCronRunSessionKey(sessionKey: string): CronRunSessionKeyParts | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const match = /^cron:([^:]+):run:([^:]+)$/.exec(parsed.rest);
  if (!match) {
    return null;
  }
  const [, jobId, runId] = match;
  if (!jobId || !runId) {
    return null;
  }
  return { jobId, runId };
}

function normalizeRunStatus(value: unknown): CronRunStatus | undefined {
  return value === "ok" || value === "error" || value === "skipped" ? value : undefined;
}

function normalizeFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasWeakCompletionSignal(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  // 弱信号：用于 conservative 模式的“完成态文案”兜底判断。
  return /\b(heartbeat_ok|no_reply|completed|complete|done|success)\b/i.test(text);
}

function isStrongCompletedStatus(status: CronRunStatus | undefined): boolean {
  return status === "ok" || status === "skipped";
}

function resolveConservativeIdleThresholdMs(baseIdleThresholdMs: number): number {
  return Math.max(baseIdleThresholdMs, CONSERVATIVE_MIN_IDLE_MS);
}

function resolveZombieIdleThresholdMs(idleThresholdMs?: number): number {
  if (typeof idleThresholdMs !== "number" || !Number.isFinite(idleThresholdMs)) {
    return DEFAULT_ZOMBIE_IDLE_MS;
  }
  return Math.max(1, Math.floor(idleThresholdMs));
}

export function resolveCronRunSessionCleanupMode(value?: string): CronRunSessionCleanupMode {
  // 默认走 standard，保证首次落地时清理力度可控。
  if (value === "conservative" || value === "standard" || value === "aggressive") {
    return value;
  }
  return "standard";
}

async function buildRunSignalIndex(params: {
  cronStorePath?: string;
  jobIds: Set<string>;
}): Promise<RunSignalIndex> {
  // 从 cron run history 中提取“每个 run session 的最新 finished 记录”，
  // 作为“业务已完成”的强信号来源。
  const bySessionKey = new Map<string, CronRunSignal>();
  const cronStorePath = params.cronStorePath?.trim();
  if (!cronStorePath || params.jobIds.size === 0) {
    return { bySessionKey };
  }

  for (const jobId of params.jobIds) {
    let logPath: string;
    try {
      logPath = resolveCronRunLogPath({ storePath: cronStorePath, jobId });
    } catch {
      continue;
    }
    const stream = createReadStream(logPath, { encoding: "utf-8" });
    const reader = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of reader) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!parsed || parsed.action !== "finished") {
          continue;
        }
        const sessionKey = typeof parsed.sessionKey === "string" ? parsed.sessionKey.trim() : "";
        if (!sessionKey) {
          continue;
        }
        const ts =
          normalizeFiniteTimestamp(parsed.ts) ??
          normalizeFiniteTimestamp(parsed.runAtMs) ??
          normalizeFiniteTimestamp(parsed.nextRunAtMs);
        if (ts === undefined) {
          continue;
        }
        const signal: CronRunSignal = {
          sessionKey,
          sessionId:
            typeof parsed.sessionId === "string" && parsed.sessionId.trim()
              ? parsed.sessionId.trim()
              : undefined,
          jobId,
          status: normalizeRunStatus(parsed.status),
          ts,
          runAtMs: normalizeFiniteTimestamp(parsed.runAtMs),
          summary:
            typeof parsed.summary === "string" && parsed.summary.trim()
              ? parsed.summary.trim()
              : undefined,
          error:
            typeof parsed.error === "string" && parsed.error.trim()
              ? parsed.error.trim()
              : undefined,
        };
        const previous = bySessionKey.get(sessionKey);
        // 只保留最新一条 finished 记录，避免旧日志覆盖新状态。
        if (!previous || previous.ts <= signal.ts) {
          bySessionKey.set(sessionKey, signal);
        }
      }
    } catch {
      continue;
    } finally {
      reader.close();
      stream.destroy();
    }
  }
  return { bySessionKey };
}

function buildSessionIdLatestUpdatedAtMap(
  store: Record<string, SessionEntry>,
): Map<string, number> {
  // 用 sessionId 维度聚合最新 updatedAt，用于判定该 run session 是否被复用。
  const latestBySessionId = new Map<string, number>();
  for (const entry of Object.values(store)) {
    if (!entry?.sessionId || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) {
      continue;
    }
    const prev = latestBySessionId.get(entry.sessionId);
    if (prev === undefined || prev < entry.updatedAt) {
      latestBySessionId.set(entry.sessionId, entry.updatedAt);
    }
  }
  return latestBySessionId;
}

export async function scanCronRunSessionCandidates(params: {
  sessionStorePath: string;
  cronStorePath?: string;
  nowMs?: number;
  idleThresholdMs?: number;
  mode?: CronRunSessionCleanupMode;
}): Promise<CronRunSessionScanResult> {
  const now = params.nowMs ?? Date.now();
  const mode = resolveCronRunSessionCleanupMode(params.mode);
  const idleThresholdMs = resolveZombieIdleThresholdMs(params.idleThresholdMs);
  const store = loadSessionStore(params.sessionStorePath, { skipCache: true });
  const candidates: CronRunSessionCandidate[] = [];
  const skipped = createSkipCounts();
  const cronRunEntries = Object.entries(store);
  if (cronRunEntries.length === 0) {
    return { scanned: 0, candidates, skipped };
  }

  const parsedKeyBySessionKey = new Map<string, CronRunSessionKeyParts>();
  const jobIds = new Set<string>();
  for (const [sessionKey] of cronRunEntries) {
    const parsed = parseCronRunSessionKey(sessionKey);
    if (!parsed) {
      continue;
    }
    parsedKeyBySessionKey.set(sessionKey, parsed);
    jobIds.add(parsed.jobId);
  }

  if (parsedKeyBySessionKey.size === 0) {
    return { scanned: 0, candidates, skipped };
  }

  const runSignals = await buildRunSignalIndex({
    cronStorePath: params.cronStorePath,
    jobIds,
  });
  const latestUpdatedAtBySessionId = buildSessionIdLatestUpdatedAtMap(store);

  for (const [sessionKey, entry] of cronRunEntries) {
    const parsedKey = parsedKeyBySessionKey.get(sessionKey);
    if (!parsedKey) {
      continue;
    }
    if (!entry) {
      skipped["invalid-key"] += 1;
      continue;
    }
    const sessionId = entry.sessionId?.trim();
    if (!sessionId) {
      skipped["missing-session-id"] += 1;
      continue;
    }
    const updatedAt = normalizeFiniteTimestamp(entry.updatedAt);
    if (updatedAt === undefined) {
      skipped["invalid-key"] += 1;
      continue;
    }
    const idleMs = Math.max(0, now - updatedAt);
    // 必须先满足 idle 阈值，避免把刚结束但还可能被回流使用的 session 当成僵尸。
    if (idleMs < idleThresholdMs) {
      skipped["not-idle"] += 1;
      continue;
    }

    if (hasActiveSessionRun({ sessionKey, sessionId })) {
      skipped["active-session-run"] += 1;
      continue;
    }

    // aggressive 模式会放宽运行态判断；standard/conservative 要求无 active run。
    const activeRun = mode === "aggressive" ? false : isCronJobActive(parsedKey.jobId);
    if (activeRun) {
      skipped["active-run"] += 1;
      continue;
    }
    const activeTask = resolveActiveRelatedTask(sessionKey);
    if (activeTask) {
      skipped["active-task"] += 1;
      continue;
    }
    // 同理：默认要求没有活跃子任务，避免删掉仍有后续子流程的壳。
    const activeChildRuns = mode === "aggressive" ? 0 : countActiveDescendantRuns(sessionKey);
    if (mode !== "aggressive" && activeChildRuns > 0) {
      skipped["active-child-runs"] += 1;
      continue;
    }
    if (hasActiveBackgroundExec(sessionKey)) {
      skipped["active-exec"] += 1;
      continue;
    }

    const latestUpdatedAt = latestUpdatedAtBySessionId.get(sessionId) ?? updatedAt;
    // 如果同一 sessionId 在别处出现了更晚更新时间，说明该会话壳可能已被复用。
    const reused = mode !== "aggressive" && latestUpdatedAt > updatedAt + 1_000;
    if (reused) {
      skipped.reused += 1;
      continue;
    }

    const runSignal = runSignals.bySessionKey.get(sessionKey);
    const strongCompleted = isStrongCompletedStatus(runSignal?.status);
    const weakCompleted = hasWeakCompletionSignal(runSignal?.summary);
    // standard：必须有 run history 完成态（ok/skipped）。
    if (mode === "standard" && !strongCompleted) {
      skipped["run-not-completed"] += 1;
      continue;
    }
    // conservative：在 strong signal 之外，再要求弱信号命中，降低误删概率。
    if (mode === "conservative") {
      if (!strongCompleted) {
        skipped["run-not-completed"] += 1;
        continue;
      }
      if (!weakCompleted) {
        skipped["completion-signal-missing"] += 1;
        continue;
      }
    }

    if (mode !== "aggressive") {
      const completedAtMs = runSignal?.ts ?? updatedAt;
      const requiredIdleMs =
        mode === "conservative"
          ? resolveConservativeIdleThresholdMs(idleThresholdMs)
          : idleThresholdMs;
      // 要求“完成后再次静默一段时间”，防止刚完成就被清理。
      if (now - completedAtMs < requiredIdleMs) {
        skipped["post-completion-not-idle"] += 1;
        continue;
      }
    }

    candidates.push({
      sessionKey,
      sessionId,
      jobId: parsedKey.jobId,
      label: entry.label,
      createdAtMs: runSignal?.runAtMs,
      completedAtMs: runSignal?.ts,
      lastActiveAtMs: updatedAt,
      idleMs,
      lastMessage: runSignal?.summary,
      activeRun,
      activeChildRuns,
      runStatus: runSignal?.status,
      runCompleted: strongCompleted,
    });
  }

  return {
    scanned: parsedKeyBySessionKey.size,
    candidates: candidates.toSorted((a, b) => b.idleMs - a.idleMs),
    skipped,
  };
}

export async function pruneCronRunSessionCandidates(params: {
  sessionStorePath: string;
  candidates: CronRunSessionCandidate[];
  log: Logger;
  nowMs?: number;
  archiveRetentionMs?: number;
}): Promise<{ pruned: number }> {
  if (params.candidates.length === 0) {
    return { pruned: 0 };
  }

  const candidateByKey = new Map(
    params.candidates.map((candidate) => [candidate.sessionKey, candidate] as const),
  );
  let pruned = 0;
  const prunedSessions = new Map<string, string | undefined>();

  try {
    await updateSessionStore(params.sessionStorePath, (store) => {
      for (const [sessionKey, candidate] of candidateByKey) {
        const entry = store[sessionKey];
        if (!entry?.sessionId) {
          continue;
        }
        const updatedAt = normalizeFiniteTimestamp(entry.updatedAt);
        // 删除前再次校验“sessionId + updatedAt”快照，避免并发更新时误删。
        if (updatedAt === undefined || updatedAt !== candidate.lastActiveAtMs) {
          continue;
        }
        if (entry.sessionId !== candidate.sessionId) {
          continue;
        }
        if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) {
          prunedSessions.set(entry.sessionId, entry.sessionFile);
        }
        delete store[sessionKey];
        pruned += 1;
      }
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to prune candidate sessions");
    return { pruned: 0 };
  }

  if (prunedSessions.size > 0) {
    try {
      const store = loadSessionStore(params.sessionStorePath, { skipCache: true });
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedDirs = await archiveRemovedSessionTranscripts({
        removedSessionFiles: prunedSessions,
        referencedSessionIds,
        storePath: params.sessionStorePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (archivedDirs.size > 0) {
        // 删除壳后保留归档窗口，避免立即清空可追溯材料。
        const retentionMs = Math.max(1, Math.floor(params.archiveRetentionMs ?? DEFAULT_RETENTION_MS));
        await cleanupArchivedSessionTranscripts({
          directories: [...archivedDirs],
          olderThanMs: retentionMs,
          reason: "deleted",
          nowMs: params.nowMs ?? Date.now(),
        });
      }
    } catch (err) {
      params.log.warn({ err: String(err) }, "cron-reaper: transcript cleanup failed");
    }
  }

  return { pruned };
}

export function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "h" });
    } catch {
      return DEFAULT_RETENTION_MS;
    }
  }
  return DEFAULT_RETENTION_MS;
}

export type ReaperResult = {
  swept: boolean;
  pruned: number;
  scanned?: number;
};

/**
 * Sweep the session store and prune expired cron run sessions.
 * Designed to be called from the cron timer tick — self-throttles via
 * MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
 *
 * Lock ordering: this function acquires the session-store file lock via
 * `updateSessionStore`. It must be called OUTSIDE of the cron service's
 * own `locked()` section to avoid lock-order inversions. The cron timer
 * calls this after all `locked()` sections have been released.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  /** Resolved path to cron jobs.json (used to read run history signals). */
  cronStorePath?: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;

  // Throttle: don't sweep more often than every 5 minutes.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    lastSweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  let scanned = 0;
  const scan = await scanCronRunSessionCandidates({
    sessionStorePath: storePath,
    cronStorePath: params.cronStorePath,
    nowMs: now,
    idleThresholdMs: retentionMs,
    mode: "standard",
  }).catch((err) => {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to scan session store");
    return null;
  });
  if (!scan) {
    return { swept: false, pruned: 0 };
  }
  scanned = scan.scanned;
  // 定时 reaper 只做“标准版”清理，先求稳，再求激进收缩。
  const pruneResult = await pruneCronRunSessionCandidates({
    sessionStorePath: storePath,
    candidates: scan.candidates,
    log: params.log,
    nowMs: now,
    archiveRetentionMs: retentionMs,
  });
  pruned = pruneResult.pruned;

  lastSweepAtMsByStore.set(storePath, now);

  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs },
      `cron-reaper: pruned ${pruned} expired cron run session(s)`,
    );
  }

  return { swept: true, pruned, scanned };
}

/** Reset the throttle timer (for tests). */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
}
