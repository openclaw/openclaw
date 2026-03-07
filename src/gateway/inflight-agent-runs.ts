import path from "node:path";
import type { AgentCommandIngressOpts } from "../commands/agent/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { shouldPreserveInflightAgentRunsForPendingRestart } from "../infra/restart.js";

type InflightAgentRunRecord = {
  runId: string;
  acceptedAt: number;
  opts: AgentCommandIngressOpts;
  resumeCount?: number;
  lastResumeAt?: number;
};

type InflightAgentRunsStore = {
  version: 1;
  runs: Record<string, InflightAgentRunRecord>;
};

const STORE_VERSION = 1 as const;
const STORE_FILENAME = "inflight-agent-runs.json";

// Mirrors the in-memory grace window in `src/gateway/server-methods/agent-job.ts`.
// Some embedded runs can emit transient lifecycle "error" events during failover.
const ERROR_GRACE_MS = 15_000;

let lifecycleCleanerUnsub: (() => void) | null = null;
let lifecycleCleanerEnv: NodeJS.ProcessEnv = process.env;
const pendingErrorTimers = new Map<string, NodeJS.Timeout>();
const storeLock = createAsyncLock();

export function isInflightAgentRunRecoveryEnabled(cfg: OpenClawConfig): boolean {
  return cfg.gateway?.restartRecovery?.resumeInflightAgentRuns === true;
}

function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), STORE_FILENAME);
}

function clearPendingErrorTimer(runId: string): void {
  const t = pendingErrorTimers.get(runId);
  if (!t) {
    return;
  }
  clearTimeout(t);
  pendingErrorTimers.delete(runId);
}

function scheduleErrorCleanup(runId: string, env: NodeJS.ProcessEnv): void {
  clearPendingErrorTimer(runId);
  const timer = setTimeout(() => {
    pendingErrorTimers.delete(runId);
    void removeRunFromStore(resolveStorePath(env), runId);
  }, ERROR_GRACE_MS);
  timer.unref?.();
  pendingErrorTimers.set(runId, timer);
}

async function readStore(storePath: string): Promise<InflightAgentRunsStore> {
  const parsed = await readJsonFile<unknown>(storePath);
  if (!parsed || typeof parsed !== "object") {
    return { version: STORE_VERSION, runs: {} };
  }
  const rec = parsed as Partial<InflightAgentRunsStore>;
  if (rec.version !== STORE_VERSION || !rec.runs || typeof rec.runs !== "object") {
    return { version: STORE_VERSION, runs: {} };
  }
  return { version: STORE_VERSION, runs: rec.runs };
}

async function writeStore(storePath: string, store: InflightAgentRunsStore): Promise<void> {
  await writeJsonAtomic(storePath, store, { trailingNewline: true, mode: 0o600 });
}

async function removeRunFromStore(storePath: string, runId: string): Promise<void> {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  await storeLock(async () => {
    const store = await readStore(storePath);
    if (!store.runs[cleaned]) {
      return;
    }
    delete store.runs[cleaned];
    await writeStore(storePath, store);
  });
}

export async function addInflightAgentRun(
  record: InflightAgentRunRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleanedRunId = record.runId.trim();
  if (!cleanedRunId) {
    return;
  }
  const storePath = resolveStorePath(env);
  await storeLock(async () => {
    const store = await readStore(storePath);
    store.runs[cleanedRunId] = {
      ...record,
      runId: cleanedRunId,
      acceptedAt: Math.floor(record.acceptedAt),
    };
    await writeStore(storePath, store);
  });
}

export async function removeInflightAgentRun(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  if (shouldPreserveInflightAgentRunsForPendingRestart()) {
    return;
  }
  clearPendingErrorTimer(cleaned);
  await removeRunFromStore(resolveStorePath(env), cleaned);
}

/**
 * Batch-update resumeCount/lastResumeAt for all given runIds in a single
 * read-modify-write cycle.
 */
export async function markInflightAgentRunsResumed(
  runIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = runIds.map((id) => id.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return;
  }
  const storePath = resolveStorePath(env);
  const now = Date.now();
  await storeLock(async () => {
    const store = await readStore(storePath);
    let changed = false;
    for (const id of cleaned) {
      const existing = store.runs[id];
      if (!existing) {
        continue;
      }
      store.runs[id] = {
        ...existing,
        resumeCount: (existing.resumeCount ?? 0) + 1,
        lastResumeAt: now,
      };
      changed = true;
    }
    if (changed) {
      await writeStore(storePath, store);
    }
  });
}

export async function listInflightAgentRuns(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InflightAgentRunRecord[]> {
  const store = await readStore(resolveStorePath(env));
  return Object.values(store.runs ?? {});
}

export async function clearInflightAgentRuns(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const storePath = resolveStorePath(env);
  await storeLock(async () => {
    await writeStore(storePath, { version: STORE_VERSION, runs: {} });
  });
}

/**
 * Start a best-effort lifecycle listener to clean up persisted inflight runs.
 *
 * - On lifecycle end: remove the record immediately.
 * - On lifecycle error: remove after a grace window unless a new lifecycle start arrives.
 *
 * This reduces the chance of re-running completed sessions after restart.
 */
export function ensureInflightAgentRunLifecycleCleanerStarted(
  env: NodeJS.ProcessEnv = process.env,
): void {
  lifecycleCleanerEnv = env;
  if (lifecycleCleanerUnsub) {
    return;
  }
  lifecycleCleanerUnsub = onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      clearPendingErrorTimer(evt.runId);
      return;
    }
    if (phase === "end") {
      if (shouldPreserveInflightAgentRunsForPendingRestart()) {
        return;
      }
      void removeRunFromStore(resolveStorePath(lifecycleCleanerEnv), evt.runId);
      return;
    }
    if (phase === "error") {
      if (shouldPreserveInflightAgentRunsForPendingRestart()) {
        return;
      }
      scheduleErrorCleanup(evt.runId, lifecycleCleanerEnv);
    }
  });
}

export const __test = {
  resolveStorePath,
  readStore: async (env: NodeJS.ProcessEnv = process.env) => {
    return await readStore(resolveStorePath(env));
  },
  reset: () => {
    lifecycleCleanerUnsub?.();
    lifecycleCleanerUnsub = null;
    lifecycleCleanerEnv = process.env;
    for (const timer of pendingErrorTimers.values()) {
      clearTimeout(timer);
    }
    pendingErrorTimers.clear();
  },
};
