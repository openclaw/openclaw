import { onAgentEvent } from "../../infra/agent-events.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
const agentRunCache = new Map<string, AgentRunSnapshot>();
const agentRunStarts = new Map<string, number>();
let agentRunListenerStarted = false;

type AgentRunSnapshot = {
  runId: string;
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  finalAssistantText?: string;
  ts: number;
};

type AgentRunAssistantText = {
  text: string;
  ts: number;
};

const agentRunAssistantTexts = new Map<string, AgentRunAssistantText>();

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, entry] of agentRunCache) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunCache.delete(runId);
    }
  }
  for (const [runId, entry] of agentRunAssistantTexts) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunAssistantTexts.delete(runId);
    }
  }
}

function recordAgentRunSnapshot(entry: AgentRunSnapshot) {
  pruneAgentRunCache(entry.ts);
  agentRunCache.set(entry.runId, entry);
}

function extractAssistantText(data: Record<string, unknown> | undefined): {
  mode: "set" | "append";
  text: string;
} | null {
  if (!data) {
    return null;
  }
  const text = data.text;
  if (typeof text === "string" && text.trim()) {
    return { mode: "set", text };
  }
  const delta = data.delta;
  if (typeof delta === "string" && delta.length > 0) {
    return { mode: "append", text: delta };
  }
  return null;
}

function recordAssistantText(runId: string, text: string, mode: "set" | "append" = "set") {
  const ts = Date.now();
  pruneAgentRunCache(ts);
  if (mode === "append") {
    const previous = agentRunAssistantTexts.get(runId)?.text ?? "";
    agentRunAssistantTexts.set(runId, { text: `${previous}${text}`, ts });
    return;
  }
  agentRunAssistantTexts.set(runId, { text, ts });
}

function consumeAssistantText(runId: string): string | undefined {
  const entry = agentRunAssistantTexts.get(runId);
  agentRunAssistantTexts.delete(runId);
  return entry?.text;
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream === "assistant") {
      const update = extractAssistantText(evt.data);
      if (update) {
        recordAssistantText(evt.runId, update.text, update.mode);
      }
      return;
    }
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      agentRunStarts.set(evt.runId, startedAt ?? Date.now());
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const startedAt =
      typeof evt.data?.startedAt === "number" ? evt.data.startedAt : agentRunStarts.get(evt.runId);
    const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
    const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
    const finalAssistantText = consumeAssistantText(evt.runId);
    agentRunStarts.delete(evt.runId);
    recordAgentRunSnapshot({
      runId: evt.runId,
      status: phase === "error" ? "error" : evt.data?.aborted ? "timeout" : "ok",
      startedAt,
      endedAt,
      error,
      finalAssistantText,
      ts: Date.now(),
    });
  });
}

function getCachedAgentRun(runId: string) {
  pruneAgentRunCache();
  return agentRunCache.get(runId);
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
}): Promise<AgentRunSnapshot | null> {
  const { runId, timeoutMs } = params;
  ensureAgentRunListener();
  const cached = getCachedAgentRun(runId);
  if (cached) {
    return cached;
  }
  if (timeoutMs <= 0) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (entry: AgentRunSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(entry);
    };
    const unsubscribe = onAgentEvent((evt) => {
      if (!evt) {
        return;
      }
      if (evt.stream !== "lifecycle") {
        return;
      }
      if (evt.runId !== runId) {
        return;
      }
      const phase = evt.data?.phase;
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const cached = getCachedAgentRun(runId);
      if (cached) {
        finish(cached);
        return;
      }
      const startedAt =
        typeof evt.data?.startedAt === "number"
          ? evt.data.startedAt
          : agentRunStarts.get(evt.runId);
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      const finalAssistantText = consumeAssistantText(evt.runId);
      const snapshot: AgentRunSnapshot = {
        runId: evt.runId,
        status: phase === "error" ? "error" : evt.data?.aborted ? "timeout" : "ok",
        startedAt,
        endedAt,
        error,
        finalAssistantText,
        ts: Date.now(),
      };
      recordAgentRunSnapshot(snapshot);
      finish(snapshot);
    });
    const timerDelayMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
    const timer = setTimeout(() => finish(null), timerDelayMs);
  });
}

ensureAgentRunListener();
