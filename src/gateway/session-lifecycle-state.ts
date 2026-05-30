import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { readRecentSessionMessages } from "./session-utils.fs.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    error?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "sessionId"
  | "sessionFile"
  | "channel"
  | "route"
  | "deliveryContext"
  | "lastChannel"
  | "origin"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function mapAgentRunTerminalOutcomeToSessionStatus(
  outcome: AgentRunTerminalOutcome,
): SessionRunStatus {
  switch (outcome.reason) {
    case "completed":
      return "done";
    case "hard_timeout":
    case "timed_out":
      return "timeout";
    case "cancelled":
    case "aborted":
      return "killed";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return outcome.reason satisfies never;
  }
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  const terminal = buildAgentRunTerminalOutcome({
    status: phase === "error" ? "error" : event.data?.aborted === true ? "timeout" : "ok",
    error: event.data?.error,
    stopReason: event.data?.stopReason,
    livenessState: event.data?.livenessState,
    timeoutPhase: event.data?.timeoutPhase,
    providerStarted: event.data?.providerStarted,
    startedAt: event.data?.startedAt,
    endedAt: event.data?.endedAt ?? event.ts,
  });
  return mapAgentRunTerminalOutcomeToSessionStatus(terminal);
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

function readMessageRole(message: unknown): string | undefined {
  return message && typeof message === "object" && !Array.isArray(message)
    ? typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : undefined
    : undefined;
}

function readMessageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (isFiniteTimestamp(timestamp)) {
    return timestamp;
  }
  const meta = (message as { __openclaw?: unknown })["__openclaw"];
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const recordTimestampMs = (meta as { recordTimestampMs?: unknown }).recordTimestampMs;
    if (isFiniteTimestamp(recordTimestampMs)) {
      return recordTimestampMs;
    }
  }
  return undefined;
}

function readMessageText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const record = message as { content?: unknown; text?: unknown };
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) {
    return "";
  }
  return record.content
    .map((block) =>
      block && typeof block === "object" && !Array.isArray(block)
        ? typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : ""
        : "",
    )
    .join("");
}

function isAbortedAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const record = message as {
    aborted?: unknown;
    openclawAbort?: unknown;
    stopReason?: unknown;
  };
  if (record.aborted === true || record.stopReason === "aborted") {
    return true;
  }
  const abortMeta = record.openclawAbort;
  return (
    abortMeta !== null &&
    typeof abortMeta === "object" &&
    !Array.isArray(abortMeta) &&
    (abortMeta as { aborted?: unknown }).aborted === true
  );
}

function hasSuccessfulAssistantMessage(params: {
  entry: Partial<PersistedLifecycleSessionShape>;
  storePath: string;
  startedAt?: number;
  endedAt?: number;
}): boolean {
  if (!params.entry.sessionId) {
    return false;
  }
  const messages = readRecentSessionMessages(
    params.entry.sessionId,
    params.storePath,
    params.entry.sessionFile,
    {
      maxMessages: 12,
      maxBytes: 96 * 1024,
      maxLines: 160,
    },
  );
  const startedAt = params.startedAt;
  const endedAt = params.endedAt;
  return messages.some((message) => {
    if (readMessageRole(message) !== "assistant") {
      return false;
    }
    if (isAbortedAssistantMessage(message)) {
      return false;
    }
    const text = readMessageText(message).trim();
    if (!text || text === "[assistant turn failed before producing content]") {
      return false;
    }
    const timestamp = readMessageTimestamp(message);
    if (isFiniteTimestamp(startedAt) && !isFiniteTimestamp(timestamp)) {
      return false;
    }
    if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(timestamp) && timestamp < startedAt) {
      return false;
    }
    if (isFiniteTimestamp(endedAt) && isFiniteTimestamp(timestamp) && timestamp > endedAt + 5_000) {
      return false;
    }
    const stopReason =
      message && typeof message === "object" && !Array.isArray(message)
        ? (message as { stopReason?: unknown }).stopReason
        : undefined;
    if (typeof stopReason === "string" && stopReason !== "stop" && stopReason !== "end_turn") {
      return false;
    }
    return true;
  });
}

function isInternalSessionEntry(entry: Partial<PersistedLifecycleSessionShape> | undefined) {
  if (!entry) {
    return false;
  }
  const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const routeChannel =
    entry.route && typeof entry.route === "object" && !Array.isArray(entry.route)
      ? (entry.route as { channel?: unknown }).channel
      : undefined;
  const deliveryChannel =
    entry.deliveryContext &&
    typeof entry.deliveryContext === "object" &&
    !Array.isArray(entry.deliveryContext)
      ? (entry.deliveryContext as { channel?: unknown }).channel
      : undefined;
  const originProvider =
    entry.origin && typeof entry.origin === "object" && !Array.isArray(entry.origin)
      ? (entry.origin as { provider?: unknown }).provider
      : undefined;
  const effectiveChannel =
    stringValue(deliveryChannel) ??
    stringValue(routeChannel) ??
    stringValue(entry.channel) ??
    stringValue(entry.lastChannel) ??
    stringValue(originProvider);
  return effectiveChannel ? isInternalMessageChannel(effectiveChannel) : false;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
  storePath?: string;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  if (
    snapshot.status &&
    snapshot.status === "failed" &&
    isFiniteTimestamp(params.event.data?.startedAt) &&
    params.entry &&
    params.storePath &&
    isInternalSessionEntry(params.entry) &&
    hasSuccessfulAssistantMessage({
      entry: params.entry,
      storePath: params.storePath,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
    })
  ) {
    return {
      ...snapshot,
      updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
      status: "done",
      abortedLastRun: false,
    };
  }
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  agentId?: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
  if (!sessionEntry.entry) {
    return;
  }

  await updateSessionStoreEntry({
    storePath: sessionEntry.storePath,
    sessionKey: sessionEntry.canonicalKey,
    skipMaintenance: true,
    takeCacheOwnership: true,
    update: async (entry) =>
      derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
        storePath: sessionEntry.storePath,
      }),
  });
}
