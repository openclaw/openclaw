import path from "node:path";
import type { AgentCommandIngressOpts } from "../commands/agent/types.js";
import { resolveStateDir } from "../config/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../infra/json-files.js";

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
const pendingErrorTimers = new Map<string, NodeJS.Timeout>();
const knownStorePaths = new Set<string>();
const storeLocks = new Map<string, ReturnType<typeof createAsyncLock>>();

function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), STORE_FILENAME);
}

function registerStorePath(storePath: string) {
  knownStorePaths.add(storePath);
}

function withStoreLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const lock = storeLocks.get(storePath) ?? createAsyncLock();
  storeLocks.set(storePath, lock);
  return lock(fn);
}

function clearPendingErrorTimer(runId: string): void {
  const t = pendingErrorTimers.get(runId);
  if (!t) {
    return;
  }
  clearTimeout(t);
  pendingErrorTimers.delete(runId);
}

function scheduleErrorCleanup(runId: string): void {
  clearPendingErrorTimer(runId);
  const timer = setTimeout(() => {
    pendingErrorTimers.delete(runId);
    void removeInflightAgentRunFromAllKnownStores(runId);
  }, ERROR_GRACE_MS);
  timer.unref?.();
  pendingErrorTimers.set(runId, timer);
}

async function readStoreFromPath(storePath: string): Promise<InflightAgentRunsStore> {
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

async function writeStoreToPath(storePath: string, store: InflightAgentRunsStore): Promise<void> {
  await writeJsonAtomic(storePath, store, { trailingNewline: true, mode: 0o600 });
}

async function removeInflightAgentRunFromStorePath(
  storePath: string,
  runId: string,
): Promise<void> {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  await withStoreLock(storePath, async () => {
    const store = await readStoreFromPath(storePath);
    if (!store.runs[cleaned]) {
      return;
    }
    delete store.runs[cleaned];
    await writeStoreToPath(storePath, store);
  });
}

async function removeInflightAgentRunFromAllKnownStores(runId: string): Promise<void> {
  const storePaths = Array.from(knownStorePaths);
  if (storePaths.length === 0) {
    return;
  }
  await Promise.all(
    storePaths.map((storePath) =>
      removeInflightAgentRunFromStorePath(storePath, runId).catch(() => {}),
    ),
  );
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
  registerStorePath(storePath);
  await withStoreLock(storePath, async () => {
    const store = await readStoreFromPath(storePath);
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
    await writeStoreToPath(storePath, store);
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
  clearPendingErrorTimer(cleaned);
  const storePath = resolveStorePath(env);
  registerStorePath(storePath);
  await removeInflightAgentRunFromStorePath(storePath, cleaned);
}

export async function markInflightAgentRunResumed(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  const storePath = resolveStorePath(env);
  registerStorePath(storePath);
  await withStoreLock(storePath, async () => {
    const store = await readStoreFromPath(storePath);
    const existing = store.runs[cleaned];
    if (!existing) {
      return;
    }
    store.runs[cleaned] = {
      ...existing,
      resumeCount: (existing.resumeCount ?? 0) + 1,
      lastResumeAt: Date.now(),
    };
    await writeStoreToPath(storePath, store);
  });
}

export async function listInflightAgentRuns(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InflightAgentRunRecord[]> {
  const storePath = resolveStorePath(env);
  registerStorePath(storePath);
  const store = await readStoreFromPath(storePath);
  return Object.values(store.runs ?? {});
}

export async function clearInflightAgentRuns(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const storePath = resolveStorePath(env);
  registerStorePath(storePath);
  await withStoreLock(storePath, async () => {
    await writeStoreToPath(storePath, { version: STORE_VERSION, runs: {} });
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
  registerStorePath(resolveStorePath(env));
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
      void removeInflightAgentRunFromAllKnownStores(evt.runId);
      return;
    }
    if (phase === "error") {
      scheduleErrorCleanup(evt.runId);
    }
  });
}

export const __test = {
  resolveStorePath,
  readStore: async (env: NodeJS.ProcessEnv = process.env) => {
    const storePath = resolveStorePath(env);
    registerStorePath(storePath);
    return await readStoreFromPath(storePath);
  },
  reset: () => {
    lifecycleCleanerUnsub?.();
    lifecycleCleanerUnsub = null;
    for (const timer of pendingErrorTimers.values()) {
      clearTimeout(timer);
    }
    pendingErrorTimers.clear();
    knownStorePaths.clear();
    storeLocks.clear();
  },
};
