import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = "running" | "completed" | "failed" | "aborted";

export type JobToolCall = {
  toolCallId: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
};

export type TrackedJob = {
  runId: string;
  status: JobStatus;
  sessionKey?: string;
  channel?: string;
  agentId?: string;
  lane?: string;
  isHeartbeat?: boolean;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  toolCalls: JobToolCall[];
  activeToolCount: number;
  textPreview: string;
  thinkingPreview: string;
  error?: string;
};

export type JobListParams = {
  status?: string | string[];
  channel?: string;
  limit?: number;
  includeCompleted?: boolean;
  hideHeartbeats?: boolean;
};

export type JobListResult = {
  ts: number;
  jobs: TrackedJob[];
  total: number;
  activeCount: number;
};

export type JobTracker = {
  handleEvent: (evt: AgentEventPayload) => void;
  list: (params?: JobListParams) => JobListResult;
  get: (runId: string) => TrackedJob | null;
  getActiveCount: () => number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_COMPLETED = 200;
const COMPLETED_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TOOL_CALLS = 200;
const MAX_TEXT_PREVIEW = 500;
const MAX_THINKING_PREVIEW = 300;
const BROADCAST_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function channelFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  // Session key format: agent:<agentId>:<rest>
  // Where <rest> can be:
  //   main                          -> webchat
  //   discord:dm:userid             -> discord
  //   telegram:dm:userid            -> telegram
  //   slack:channel:channelid       -> slack
  //   dm:userid                     -> webchat (per-peer without channel)
  //   subagent:...                  -> subagent
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") {
    return undefined;
  }
  const rest = parts.slice(2);
  const first = rest[0];
  if (!first) {
    return undefined;
  }
  // Known channel names
  const knownChannels = new Set([
    "discord",
    "telegram",
    "slack",
    "signal",
    "imessage",
    "whatsapp",
    "nostr",
    "googlechat",
    "msteams",
    "matrix",
    "zalo",
    "zalouser",
    "voice-call",
  ]);
  if (knownChannels.has(first)) {
    return first;
  }
  if (first === "subagent") {
    return "subagent";
  }
  if (first === "dm") {
    return "webchat";
  }
  if (first === "main" || first.length <= 20) {
    return "webchat";
  }
  return undefined;
}

function agentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") {
    return undefined;
  }
  return parts[1];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max);
}

function snapshotJob(job: InternalJob): TrackedJob {
  return {
    runId: job.runId,
    status: job.status,
    sessionKey: job.sessionKey,
    channel: job.channel,
    agentId: job.agentId,
    lane: job.lane,
    isHeartbeat: job.isHeartbeat || undefined,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.endedAt ? job.endedAt - job.startedAt : undefined,
    toolCalls: job.toolCalls.slice(),
    activeToolCount: job.activeToolCount,
    textPreview: job.textPreview,
    thinkingPreview: job.thinkingPreview,
    error: job.error,
  };
}

// ---------------------------------------------------------------------------
// Internal job state
// ---------------------------------------------------------------------------

type InternalJob = {
  runId: string;
  status: JobStatus;
  sessionKey?: string;
  channel?: string;
  agentId?: string;
  lane?: string;
  isHeartbeat: boolean;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  toolCalls: JobToolCall[];
  activeToolCount: number;
  textPreview: string;
  thinkingPreview: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createJobTracker(opts: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): JobTracker {
  const activeJobs = new Map<string, InternalJob>();
  const completedJobs: InternalJob[] = [];
  const toolDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  // ------- Broadcast helpers -------

  function broadcastJobUpdate(job: InternalJob) {
    opts.broadcast("jobs", { type: "update", job: snapshotJob(job) }, { dropIfSlow: true });
  }

  function debouncedBroadcast(job: InternalJob) {
    const existing = toolDebounce.get(job.runId);
    if (existing) {
      clearTimeout(existing);
    }
    toolDebounce.set(
      job.runId,
      setTimeout(() => {
        toolDebounce.delete(job.runId);
        if (activeJobs.has(job.runId)) {
          broadcastJobUpdate(job);
        }
      }, BROADCAST_DEBOUNCE_MS),
    );
  }

  // ------- Completed ring buffer -------

  function addCompleted(job: InternalJob) {
    completedJobs.unshift(job);
    pruneCompleted();
  }

  function pruneCompleted() {
    const now = Date.now();
    // Remove expired entries from the end
    while (completedJobs.length > 0) {
      const last = completedJobs[completedJobs.length - 1];
      if (last && last.endedAt && now - last.endedAt > COMPLETED_TTL_MS) {
        completedJobs.pop();
      } else {
        break;
      }
    }
    // Enforce max size
    while (completedJobs.length > MAX_COMPLETED) {
      completedJobs.pop();
    }
  }

  // ------- Event handler -------

  function handleEvent(evt: AgentEventPayload) {
    const { runId, stream, data } = evt;
    if (!runId) {
      return;
    }

    // Lifecycle events
    if (stream === "lifecycle") {
      const phase = typeof data?.phase === "string" ? data.phase : "";

      if (phase === "start") {
        const runContext = getAgentRunContext(runId);
        const sessionKey = evt.sessionKey ?? runContext?.sessionKey;
        const job: InternalJob = {
          runId,
          status: "running",
          sessionKey,
          channel: runContext?.channel ?? channelFromSessionKey(sessionKey),
          agentId: agentIdFromSessionKey(sessionKey),
          isHeartbeat: runContext?.isHeartbeat ?? false,
          startedAt: typeof data?.startedAt === "number" ? data.startedAt : evt.ts,
          toolCalls: [],
          activeToolCount: 0,
          textPreview: "",
          thinkingPreview: "",
        };
        activeJobs.set(runId, job);
        broadcastJobUpdate(job);
        return;
      }

      if (phase === "end" || phase === "error") {
        const job = activeJobs.get(runId);
        if (!job) {
          return;
        }
        job.status = phase === "error" ? "failed" : "completed";
        job.endedAt = typeof data?.endedAt === "number" ? data.endedAt : evt.ts;
        job.durationMs = job.endedAt - job.startedAt;
        if (phase === "error" && typeof data?.error === "string") {
          job.error = data.error;
        }
        activeJobs.delete(runId);
        addCompleted(job);
        // Cancel any pending debounce
        const pending = toolDebounce.get(runId);
        if (pending) {
          clearTimeout(pending);
          toolDebounce.delete(runId);
        }
        broadcastJobUpdate(job);
        return;
      }
      return;
    }

    // Tool events
    if (stream === "tool") {
      const job = activeJobs.get(runId);
      if (!job) {
        return;
      }
      const phase = typeof data?.phase === "string" ? data.phase : "";
      const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : "";
      const name = typeof data?.name === "string" ? data.name : "";

      if (phase === "start" && toolCallId) {
        if (job.toolCalls.length < MAX_TOOL_CALLS) {
          job.toolCalls.push({
            toolCallId,
            name,
            startedAt: evt.ts,
          });
        }
        job.activeToolCount += 1;
        debouncedBroadcast(job);
        return;
      }

      if ((phase === "result" || phase === "end") && toolCallId) {
        const tc = job.toolCalls.find((t) => t.toolCallId === toolCallId);
        if (tc) {
          tc.endedAt = evt.ts;
          tc.isError = Boolean(data?.isError);
        }
        job.activeToolCount = Math.max(0, job.activeToolCount - 1);
        debouncedBroadcast(job);
        return;
      }
      return;
    }

    // Assistant text events
    if (stream === "assistant") {
      const job = activeJobs.get(runId);
      if (!job) {
        return;
      }
      const text = typeof data?.text === "string" ? data.text : "";
      if (text) {
        job.textPreview = truncate(text, MAX_TEXT_PREVIEW);
        // No broadcast for text deltas — too noisy
      }
      return;
    }

    // Thinking events
    if (stream === "thinking") {
      const job = activeJobs.get(runId);
      if (!job) {
        return;
      }
      const text = typeof data?.text === "string" ? data.text : "";
      if (text) {
        job.thinkingPreview = truncate(text, MAX_THINKING_PREVIEW);
      }
      return;
    }
  }

  // ------- Query API -------

  function list(params?: JobListParams): JobListResult {
    const limit = params?.limit ?? 100;
    const includeCompleted = params?.includeCompleted ?? true;
    const hideHeartbeats = params?.hideHeartbeats ?? false;
    const statusFilter = params?.status
      ? Array.isArray(params.status)
        ? new Set(params.status)
        : new Set([params.status])
      : null;
    const channelFilter = params?.channel ?? null;

    const all: TrackedJob[] = [];

    // Active jobs first (newest first by startedAt)
    const active = Array.from(activeJobs.values()).toSorted((a, b) => b.startedAt - a.startedAt);
    for (const job of active) {
      if (hideHeartbeats && job.isHeartbeat) {
        continue;
      }
      if (statusFilter && !statusFilter.has(job.status)) {
        continue;
      }
      if (channelFilter && job.channel !== channelFilter) {
        continue;
      }
      all.push(snapshotJob(job));
    }

    // Completed jobs (already sorted newest first)
    if (includeCompleted) {
      pruneCompleted();
      for (const job of completedJobs) {
        if (hideHeartbeats && job.isHeartbeat) {
          continue;
        }
        if (statusFilter && !statusFilter.has(job.status)) {
          continue;
        }
        if (channelFilter && job.channel !== channelFilter) {
          continue;
        }
        all.push(snapshotJob(job));
        if (all.length >= limit) {
          break;
        }
      }
    }

    return {
      ts: Date.now(),
      jobs: all.slice(0, limit),
      total: all.length,
      activeCount: activeJobs.size,
    };
  }

  function get(runId: string): TrackedJob | null {
    const active = activeJobs.get(runId);
    if (active) {
      return snapshotJob(active);
    }
    const completed = completedJobs.find((j) => j.runId === runId);
    if (completed) {
      return snapshotJob(completed);
    }
    return null;
  }

  function getActiveCount(): number {
    return activeJobs.size;
  }

  return {
    handleEvent,
    list,
    get,
    getActiveCount,
  };
}
