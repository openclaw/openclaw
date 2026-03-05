import fs from "node:fs/promises";
import path from "node:path";
import type { AgentCommandIngressOpts } from "../commands/agent/types.js";
import { resolveStateDir } from "../config/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";

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

let lifecycleCleanerStarted = false;
const pendingErrorTimers = new Map<string, NodeJS.Timeout>();

function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), STORE_FILENAME);
}

async function readStore(env: NodeJS.ProcessEnv = process.env): Promise<InflightAgentRunsStore> {
  const filePath = resolveStorePath(env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: STORE_VERSION, runs: {} };
    }
    const rec = parsed as Partial<InflightAgentRunsStore>;
    if (rec.version !== STORE_VERSION || !rec.runs || typeof rec.runs !== "object") {
      return { version: STORE_VERSION, runs: {} };
    }
    return { version: STORE_VERSION, runs: rec.runs };
  } catch {
    return { version: STORE_VERSION, runs: {} };
  }
}

async function writeStore(
  store: InflightAgentRunsStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveStorePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const data = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(tmp, data, "utf-8");
  await fs.rename(tmp, filePath);
}

function clearPendingErrorTimer(runId: string): void {
  const t = pendingErrorTimers.get(runId);
  if (!t) {
    return;
  }
  clearTimeout(t);
  pendingErrorTimers.delete(runId);
}

function scheduleErrorCleanup(runId: string, env: NodeJS.ProcessEnv = process.env): void {
  clearPendingErrorTimer(runId);
  const timer = setTimeout(() => {
    pendingErrorTimers.delete(runId);
    void removeInflightAgentRun(runId, env);
  }, ERROR_GRACE_MS);
  timer.unref?.();
  pendingErrorTimers.set(runId, timer);
}

export async function addInflightAgentRun(
  record: InflightAgentRunRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleanedRunId = record.runId.trim();
  if (!cleanedRunId) {
    return;
  }
  const store = await readStore(env);
  store.runs[cleanedRunId] = {
    ...record,
    runId: cleanedRunId,
    acceptedAt: Math.floor(record.acceptedAt),
    opts: {
      ...record.opts,
      runId: cleanedRunId,
      senderIsOwner: record.opts.senderIsOwner,
    },
  };
  await writeStore(store, env);
}

export async function removeInflightAgentRun(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  clearPendingErrorTimer(cleaned);
  const store = await readStore(env);
  if (!store.runs[cleaned]) {
    return;
  }
  delete store.runs[cleaned];
  await writeStore(store, env);
}

export async function markInflightAgentRunResumed(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  const store = await readStore(env);
  const existing = store.runs[cleaned];
  if (!existing) {
    return;
  }
  store.runs[cleaned] = {
    ...existing,
    resumeCount: (existing.resumeCount ?? 0) + 1,
    lastResumeAt: Date.now(),
  };
  await writeStore(store, env);
}

export async function listInflightAgentRuns(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InflightAgentRunRecord[]> {
  const store = await readStore(env);
  return Object.values(store.runs);
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
  if (lifecycleCleanerStarted) {
    return;
  }
  lifecycleCleanerStarted = true;
  onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      clearPendingErrorTimer(evt.runId);
      return;
    }
    if (phase === "end") {
      void removeInflightAgentRun(evt.runId, env);
      return;
    }
    if (phase === "error") {
      scheduleErrorCleanup(evt.runId, env);
    }
  });
}

export const __test = {
  resolveStorePath,
  readStore,
};
