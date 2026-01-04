import { onAgentEvent } from "../../infra/agent-events.js";

const AGENT_JOB_CACHE_TTL_MS = 10 * 60_000;
const agentJobCache = new Map<string, AgentJobSnapshot>();
const agentRunStarts = new Map<string, number>();
let agentJobListenerStarted = false;

type AgentJobSnapshot = {
  runId: string;
  state: "done" | "error";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  ts: number;
};

function pruneAgentJobCache(now = Date.now()) {
  for (const [runId, entry] of agentJobCache) {
    if (now - entry.ts > AGENT_JOB_CACHE_TTL_MS) {
      agentJobCache.delete(runId);
    }
  }
}

function recordAgentJobSnapshot(entry: AgentJobSnapshot) {
  pruneAgentJobCache(entry.ts);
  agentJobCache.set(entry.runId, entry);
}

function ensureAgentJobListener() {
  if (agentJobListenerStarted) return;
  agentJobListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) return;
    if (evt.stream !== "job") return;
    const state = evt.data?.state;
    if (state === "started") {
      const startedAt =
        typeof evt.data?.startedAt === "number"
          ? (evt.data.startedAt as number)
          : undefined;
      if (startedAt !== undefined) {
        agentRunStarts.set(evt.runId, startedAt);
      }
      return;
    }
    if (state !== "done" && state !== "error") return;
    const startedAt =
      typeof evt.data?.startedAt === "number"
        ? (evt.data.startedAt as number)
        : agentRunStarts.get(evt.runId);
    const endedAt =
      typeof evt.data?.endedAt === "number"
        ? (evt.data.endedAt as number)
        : undefined;
    const error =
      typeof evt.data?.error === "string"
        ? (evt.data.error as string)
        : undefined;
    agentRunStarts.delete(evt.runId);
    recordAgentJobSnapshot({
      runId: evt.runId,
      state: state === "error" ? "error" : "done",
      startedAt,
      endedAt,
      error,
      ts: Date.now(),
    });
  });
}

function matchesAfterMs(entry: AgentJobSnapshot, afterMs?: number) {
  if (afterMs === undefined) return true;
  if (typeof entry.startedAt === "number") return entry.startedAt >= afterMs;
  if (typeof entry.endedAt === "number") return entry.endedAt >= afterMs;
  return false;
}

function getCachedAgentJob(runId: string, afterMs?: number) {
  pruneAgentJobCache();
  const cached = agentJobCache.get(runId);
  if (!cached) return undefined;
  return matchesAfterMs(cached, afterMs) ? cached : undefined;
}

export async function waitForAgentJob(params: {
  runId: string;
  afterMs?: number;
  timeoutMs: number;
}): Promise<AgentJobSnapshot | null> {
  const { runId, afterMs, timeoutMs } = params;
  ensureAgentJobListener();
  const cached = getCachedAgentJob(runId, afterMs);
  if (cached) return cached;
  if (timeoutMs <= 0) return null;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (entry: AgentJobSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(entry);
    };
    const unsubscribe = onAgentEvent((evt) => {
      if (!evt || evt.stream !== "job") return;
      if (evt.runId !== runId) return;
      const state = evt.data?.state;
      if (state !== "done" && state !== "error") return;
      const startedAt =
        typeof evt.data?.startedAt === "number"
          ? (evt.data.startedAt as number)
          : agentRunStarts.get(evt.runId);
      const endedAt =
        typeof evt.data?.endedAt === "number"
          ? (evt.data.endedAt as number)
          : undefined;
      const error =
        typeof evt.data?.error === "string"
          ? (evt.data.error as string)
          : undefined;
      const snapshot: AgentJobSnapshot = {
        runId: evt.runId,
        state: state === "error" ? "error" : "done",
        startedAt,
        endedAt,
        error,
        ts: Date.now(),
      };
      recordAgentJobSnapshot(snapshot);
      if (!matchesAfterMs(snapshot, afterMs)) return;
      finish(snapshot);
    });
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
  });
}

ensureAgentJobListener();
