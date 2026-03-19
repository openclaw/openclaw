import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import {
  deriveGatewaySessionLifecycleSnapshot,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";
import { loadGatewaySessionRow, loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = loadConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

function isSilentReplyLeadFragment(text: string): boolean {
  const normalized = text.trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (!/^[A-Z_]+$/.test(normalized)) {
    return false;
  }
  if (normalized === SILENT_REPLY_TOKEN) {
    return false;
  }
  return SILENT_REPLY_TOKEN.startsWith(normalized);
}

/**
 * Treat an event as a safe replacement only when `nextText` already carries the
 * full visible assistant text for this step.
 *
 * Example:
 * - ACP cumulative snapshot: previous=`Hello`, nextText=`Hello world`,
 *   nextDelta=` world` => safe full replacement.
 * - Ambiguous delta-only producer: nextText=``, nextDelta=` world` => not safe.
 */
function isFullVisibleTextEvent(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}) {
  const { previousText, nextText, nextDelta } = params;
  if (!nextText) {
    return false;
  }
  if (!nextDelta) {
    return true;
  }
  if (!previousText) {
    return false;
  }
  if (nextText === previousText) {
    return false;
  }
  return nextText.startsWith(previousText);
}

function isEmptyBaseMirroredTextEvent(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}) {
  const { previousText, nextText, nextDelta } = params;
  return !previousText && Boolean(nextText) && nextText === nextDelta;
}

function isDeltaOnlyAssistantEvent(params: { nextText: string; nextDelta: string }) {
  return !params.nextText && Boolean(params.nextDelta);
}

function isCumulativeRecoverySnapshotFromEmptyBase(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}) {
  const { previousText, nextText, nextDelta } = params;
  return (
    !previousText &&
    Boolean(nextDelta) &&
    nextText.length > nextDelta.length &&
    nextText.endsWith(nextDelta)
  );
}

function appendUniqueSuffix(base: string, suffix: string): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);
    }
  }
  return base + suffix;
}

/**
 * Run-global seq can only force assistant recovery when we skipped over an
 * event we never observed. Already-seen tool/lifecycle events must not freeze
 * the assistant buffer.
 */
function hasObservedEventSeqGap(params: {
  hasNumericSeq: boolean;
  previousSeenEventSeq: number;
  nextSeq: number;
}) {
  return (
    params.hasNumericSeq &&
    params.previousSeenEventSeq > 0 &&
    params.nextSeq > params.previousSeenEventSeq + 1
  );
}

function hasSeenNewerRunEvent(params: {
  hasNumericSeq: boolean;
  previousSeenEventSeq: number;
  nextSeq: number;
}) {
  return params.hasNumericSeq && params.previousSeenEventSeq > params.nextSeq;
}

/**
 * Delta-only chunks are append-safe only when the run stayed observed in order.
 * If we skipped an event, wait for a full replacement instead of appending.
 */
function canAppendDelta(params: {
  hasNumericSeq: boolean;
  isWaitingForRecovery: boolean;
  hasObservedGap: boolean;
  nextText: string;
  nextDelta: string;
}) {
  return (
    params.hasNumericSeq &&
    !params.isWaitingForRecovery &&
    !params.hasObservedGap &&
    isDeltaOnlyAssistantEvent({ nextText: params.nextText, nextDelta: params.nextDelta })
  );
}

/**
 * Recovery may resume only from an event shape that proves `nextText` is the
 * complete visible assistant text. ACP-style cumulative `text` + `delta`
 * snapshots qualify; delta-only chunks must keep waiting because we cannot
 * prove whether they replay a suffix or skip hidden text.
 */
function canRecoverFromFullReplacement(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}) {
  return isFullVisibleTextEvent(params) || isCumulativeRecoverySnapshotFromEmptyBase(params);
}

function resolveMergedAssistantText(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
  allowDeltaAppend: boolean;
  allowFullReplacementShrink?: boolean;
  allowEmptyBaseRecoveryReplacement?: boolean;
  allowEmptyBaseMirroredFirstPacket?: boolean;
}) {
  const {
    previousText,
    nextText,
    nextDelta,
    allowDeltaAppend,
    allowFullReplacementShrink = false,
    allowEmptyBaseRecoveryReplacement = false,
    allowEmptyBaseMirroredFirstPacket = false,
  } = params;
  if (
    allowEmptyBaseMirroredFirstPacket &&
    isEmptyBaseMirroredTextEvent({ previousText, nextText, nextDelta })
  ) {
    return nextText;
  }
  if (isFullVisibleTextEvent({ previousText, nextText, nextDelta })) {
    if (nextText === previousText) {
      return previousText;
    }
    if (nextText.startsWith(previousText)) {
      return nextText;
    }
    if (!allowFullReplacementShrink && !nextDelta && previousText.startsWith(nextText)) {
      return previousText;
    }
    return nextText;
  }
  if (
    allowEmptyBaseRecoveryReplacement &&
    isCumulativeRecoverySnapshotFromEmptyBase({ previousText, nextText, nextDelta })
  ) {
    return nextText;
  }
  if (allowDeltaAppend) {
    return appendUniqueSuffix(previousText, nextDelta);
  }
  return previousText;
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  hasClientRunId: (clientRunId: string) => boolean;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const hasClientRunId = (clientRunId: string) => {
    for (const queue of chatRunSessions.values()) {
      if (queue.some((entry) => entry.clientRunId === clientRunId)) {
        return true;
      }
    }
    return false;
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, hasClientRunId, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  /** Highest run-global seq observed for this effective run, across all streams. */
  lastSeenEventSeq: Map<string, number>;
  /** Highest assistant-visible seq accepted into the chat buffer. */
  lastAcceptedSeq: Map<string, number>;
  /** Seq gap latch: block delta-only assistant merges until a safe full replacement arrives. */
  waitingForRecovery: Set<string>;
  /** Last assistant text that was actually broadcast to streaming clients. */
  deltaLastBroadcastText: Map<string, string>;
  deltaSentAt: Map<string, number>;
  /** Length of text at the time of the last broadcast, used to avoid duplicate flushes. */
  deltaLastBroadcastLen: Map<string, number>;
  /** Ignore late events that predate an explicitly restarted client-visible run. */
  minEventTsByEffectiveRunKey: Map<string, number>;
  /** Run keys that have already hit a terminal lifecycle event (end/error) and are finalized. */
  finalizedEffectiveRunKeys: Map<string, number>;
  /** Client-visible keys reserved by chat.send for the next real run start. */
  pendingRestartEffectiveRunKeys: Set<string>;
  /** Source run ids authorized to consume a pending client-visible restart exactly once. */
  pendingRestartSourceRunIdsByEffectiveRunKey: Map<string, string>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export type EffectiveChatRunStateSlice = Pick<
  ChatRunState,
  | "buffers"
  | "lastSeenEventSeq"
  | "lastAcceptedSeq"
  | "waitingForRecovery"
  | "deltaLastBroadcastText"
  | "deltaSentAt"
  | "deltaLastBroadcastLen"
  | "minEventTsByEffectiveRunKey"
  | "finalizedEffectiveRunKeys"
  | "pendingRestartEffectiveRunKeys"
  | "pendingRestartSourceRunIdsByEffectiveRunKey"
>;

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const lastSeenEventSeq = new Map<string, number>();
  const lastAcceptedSeq = new Map<string, number>();
  const waitingForRecovery = new Set<string>();
  const deltaLastBroadcastText = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const deltaLastBroadcastLen = new Map<string, number>();
  const minEventTsByEffectiveRunKey = new Map<string, number>();
  const finalizedEffectiveRunKeys = new Map<string, number>();
  const pendingRestartEffectiveRunKeys = new Set<string>();
  const pendingRestartSourceRunIdsByEffectiveRunKey = new Map<string, string>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    lastSeenEventSeq.clear();
    lastAcceptedSeq.clear();
    waitingForRecovery.clear();
    deltaLastBroadcastText.clear();
    deltaSentAt.clear();
    deltaLastBroadcastLen.clear();
    minEventTsByEffectiveRunKey.clear();
    finalizedEffectiveRunKeys.clear();
    pendingRestartEffectiveRunKeys.clear();
    pendingRestartSourceRunIdsByEffectiveRunKey.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    lastSeenEventSeq,
    lastAcceptedSeq,
    waitingForRecovery,
    deltaLastBroadcastText,
    deltaSentAt,
    deltaLastBroadcastLen,
    minEventTsByEffectiveRunKey,
    finalizedEffectiveRunKeys,
    pendingRestartEffectiveRunKeys,
    pendingRestartSourceRunIdsByEffectiveRunKey,
    abortedRuns,
    clear,
  };
}

export function clearEffectiveChatRunState(
  chatRunState: EffectiveChatRunStateSlice,
  effectiveRunKey: string,
) {
  chatRunState.buffers.delete(effectiveRunKey);
  chatRunState.lastSeenEventSeq.delete(effectiveRunKey);
  chatRunState.lastAcceptedSeq.delete(effectiveRunKey);
  chatRunState.waitingForRecovery.delete(effectiveRunKey);
  chatRunState.deltaLastBroadcastText.delete(effectiveRunKey);
  chatRunState.deltaSentAt.delete(effectiveRunKey);
  chatRunState.deltaLastBroadcastLen.delete(effectiveRunKey);
  chatRunState.minEventTsByEffectiveRunKey.delete(effectiveRunKey);
  chatRunState.finalizedEffectiveRunKeys.delete(effectiveRunKey);
  chatRunState.pendingRestartEffectiveRunKeys.delete(effectiveRunKey);
  chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.delete(effectiveRunKey);
}

export function markPendingEffectiveChatRunRestart(
  chatRunState: Pick<
    ChatRunState,
    "pendingRestartEffectiveRunKeys" | "pendingRestartSourceRunIdsByEffectiveRunKey"
  >,
  effectiveRunKey: string,
  sourceRunId?: string,
) {
  chatRunState.pendingRestartEffectiveRunKeys.add(effectiveRunKey);
  if (typeof sourceRunId === "string" && sourceRunId.trim()) {
    chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.set(effectiveRunKey, sourceRunId);
    return;
  }
  chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.delete(effectiveRunKey);
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

export type SessionEventSubscriberRegistry = {
  subscribe: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  getAll: () => ReadonlySet<string>;
  clear: () => void;
};

export type SessionMessageSubscriberRegistry = {
  subscribe: (connId: string, sessionKey: string) => void;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  clear: () => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createSessionEventSubscriberRegistry(): SessionEventSubscriberRegistry {
  const connIds = new Set<string>();
  const empty = new Set<string>();

  return {
    subscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.add(normalized);
    },
    unsubscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.delete(normalized);
    },
    getAll: () => (connIds.size > 0 ? connIds : empty),
    clear: () => {
      connIds.clear();
    },
  };
}

export function createSessionMessageSubscriberRegistry(): SessionMessageSubscriberRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  const connToSessionKeys = new Map<string, Set<string>>();
  const empty = new Set<string>();

  const normalize = (value: string): string => value.trim();

  return {
    subscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      const connIds = sessionToConnIds.get(normalizedSessionKey) ?? new Set<string>();
      connIds.add(normalizedConnId);
      sessionToConnIds.set(normalizedSessionKey, connIds);

      const sessionKeys = connToSessionKeys.get(normalizedConnId) ?? new Set<string>();
      sessionKeys.add(normalizedSessionKey);
      connToSessionKeys.set(normalizedConnId, sessionKeys);
    },
    unsubscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      const connIds = sessionToConnIds.get(normalizedSessionKey);
      if (connIds) {
        connIds.delete(normalizedConnId);
        if (connIds.size === 0) {
          sessionToConnIds.delete(normalizedSessionKey);
        }
      }
      const sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (sessionKeys) {
        sessionKeys.delete(normalizedSessionKey);
        if (sessionKeys.size === 0) {
          connToSessionKeys.delete(normalizedConnId);
        }
      }
    },
    unsubscribeAll: (connId: string) => {
      const normalizedConnId = normalize(connId);
      if (!normalizedConnId) {
        return;
      }
      const sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (!sessionKeys) {
        return;
      }
      for (const sessionKey of sessionKeys) {
        const connIds = sessionToConnIds.get(sessionKey);
        if (!connIds) {
          continue;
        }
        connIds.delete(normalizedConnId);
        if (connIds.size === 0) {
          sessionToConnIds.delete(sessionKey);
        }
      }
      connToSessionKeys.delete(normalizedConnId);
    },
    get: (sessionKey: string) => {
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return empty;
      }
      return sessionToConnIds.get(normalizedSessionKey) ?? empty;
    },
    clear: () => {
      sessionToConnIds.clear();
      connToSessionKeys.clear();
    },
  };
}

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
};

type EmitChatDeltaParams = {
  sessionKey: string;
  effectiveRunKey: string;
  sourceRunId: string;
  seq: number;
  text: string;
  previousSeenEventSeq: number;
  delta?: unknown;
};

type ResolveChatDeltaTextParams = Pick<
  EmitChatDeltaParams,
  "effectiveRunKey" | "seq" | "previousSeenEventSeq"
> & {
  previousText: string;
  cleanedText: string;
  cleanedDelta: string;
  hasNumericSeq: boolean;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  sessionEventSubscribers,
}: AgentEventHandlerOptions) {
  const buildSessionEventSnapshot = (sessionKey: string, evt?: AgentEventPayload) => {
    const row = loadGatewaySessionRow(sessionKey);
    const lifecyclePatch = evt
      ? deriveGatewaySessionLifecycleSnapshot({
          session: row
            ? {
                updatedAt: row.updatedAt ?? undefined,
                status: row.status,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
                runtimeMs: row.runtimeMs,
                abortedLastRun: row.abortedLastRun,
              }
            : undefined,
          event: evt,
        })
      : {};
    const session = row ? { ...row, ...lifecyclePatch } : undefined;
    const snapshotSource = session ?? lifecyclePatch;
    return {
      ...(session ? { session } : {}),
      totalTokens: row?.totalTokens,
      totalTokensFresh: row?.totalTokensFresh,
      contextTokens: row?.contextTokens,
      estimatedCostUsd: row?.estimatedCostUsd,
      modelProvider: row?.modelProvider,
      model: row?.model,
      status: snapshotSource.status,
      startedAt: snapshotSource.startedAt,
      endedAt: snapshotSource.endedAt,
      runtimeMs: snapshotSource.runtimeMs,
      updatedAt: snapshotSource.updatedAt,
      abortedLastRun: snapshotSource.abortedLastRun,
    };
  };

  const resolveRecoveryChatText = ({
    effectiveRunKey,
    previousText,
    cleanedText,
    cleanedDelta,
  }: ResolveChatDeltaTextParams) => {
    if (
      !canRecoverFromFullReplacement({
        previousText,
        nextText: cleanedText,
        nextDelta: cleanedDelta,
      })
    ) {
      return undefined;
    }
    chatRunState.waitingForRecovery.delete(effectiveRunKey);
    const replacementText = resolveMergedAssistantText({
      previousText,
      nextText: cleanedText,
      nextDelta: cleanedDelta,
      allowDeltaAppend: false,
      allowFullReplacementShrink: true,
      allowEmptyBaseRecoveryReplacement: true,
    });
    // Recovery can relock onto the stream without changing visible text.
    // That should clear the recovery latch, but it must not advance accepted seq.
    if (!replacementText || replacementText === previousText) {
      return undefined;
    }
    return replacementText;
  };

  const resolveInOrderChatText = ({
    effectiveRunKey,
    seq,
    previousSeenEventSeq,
    previousText,
    cleanedText,
    cleanedDelta,
    hasNumericSeq,
  }: ResolveChatDeltaTextParams) => {
    const hasObservedGap = hasObservedEventSeqGap({
      hasNumericSeq,
      previousSeenEventSeq,
      nextSeq: seq,
    });
    if (hasObservedGap) {
      if (
        !canRecoverFromFullReplacement({
          previousText,
          nextText: cleanedText,
          nextDelta: cleanedDelta,
        })
      ) {
        chatRunState.waitingForRecovery.add(effectiveRunKey);
        return undefined;
      }
      chatRunState.waitingForRecovery.delete(effectiveRunKey);
    }
    const mergedText = resolveMergedAssistantText({
      previousText,
      nextText: cleanedText,
      nextDelta: cleanedDelta,
      allowDeltaAppend: canAppendDelta({
        hasNumericSeq,
        isWaitingForRecovery: false,
        hasObservedGap,
        nextText: cleanedText,
        nextDelta: cleanedDelta,
      }),
      allowFullReplacementShrink: hasObservedGap,
      allowEmptyBaseRecoveryReplacement: hasObservedGap,
      allowEmptyBaseMirroredFirstPacket: !hasObservedGap,
    });
    if (!mergedText || mergedText === previousText) {
      return undefined;
    }
    return mergedText;
  };

  const emitChatDelta = ({
    sessionKey,
    effectiveRunKey,
    sourceRunId,
    seq,
    text,
    previousSeenEventSeq,
    delta,
  }: EmitChatDeltaParams) => {
    /**
     * Effective-run merge invariants:
     * - `lastSeenEventSeq` tracks the highest run-global seq observed on any stream for gap detection.
     * - `lastAcceptedSeq` tracks the highest assistant seq merged into the visible buffer.
     * - `waitingForRecovery` latches after a seq gap until a safe full-text replacement arrives.
     * - `agentRunSeq` tracks the run-global seq we have observed for client-facing event ordering.
     *
     * Normal behavior merges in-order assistant events: delta-only chunks append, while full visible
     * snapshots replace the buffer. Recovery behavior is stricter: after a gap, ignore delta-only
     * chunks until a full visible snapshot re-establishes the complete assistant text.
     */
    const cleanedText = stripInlineDirectiveTagsForDisplay(text).text;
    const cleanedDelta =
      typeof delta === "string" ? stripInlineDirectiveTagsForDisplay(delta).text : "";
    const previousText = chatRunState.buffers.get(effectiveRunKey) ?? "";
    const hasNumericSeq = Number.isFinite(seq);
    const lastAcceptedSeq = chatRunState.lastAcceptedSeq.get(effectiveRunKey) ?? 0;
    const isStaleOrReplay = hasNumericSeq && seq <= lastAcceptedSeq;
    if (isStaleOrReplay) {
      return;
    }
    const hasSeenNewerEvent = hasSeenNewerRunEvent({
      hasNumericSeq,
      previousSeenEventSeq,
      nextSeq: seq,
    });
    if (hasSeenNewerEvent) {
      chatRunState.waitingForRecovery.add(effectiveRunKey);
      return;
    }
    const mergedText = chatRunState.waitingForRecovery.has(effectiveRunKey)
      ? resolveRecoveryChatText({
          effectiveRunKey,
          seq,
          previousSeenEventSeq,
          previousText,
          cleanedText,
          cleanedDelta,
          hasNumericSeq,
        })
      : resolveInOrderChatText({
          effectiveRunKey,
          seq,
          previousSeenEventSeq,
          previousText,
          cleanedText,
          cleanedDelta,
          hasNumericSeq,
        });
    if (!mergedText) {
      return;
    }
    chatRunState.buffers.set(effectiveRunKey, mergedText);
    if (hasNumericSeq) {
      chatRunState.lastAcceptedSeq.set(effectiveRunKey, seq);
    }
    if (isSilentReplyText(mergedText, SILENT_REPLY_TOKEN)) {
      return;
    }
    if (isSilentReplyLeadFragment(mergedText)) {
      return;
    }
    if (shouldHideHeartbeatChatOutput(effectiveRunKey, sourceRunId)) {
      return;
    }
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(effectiveRunKey) ?? 0;
    if (now - last < 150) {
      return;
    }
    chatRunState.deltaSentAt.set(effectiveRunKey, now);
    chatRunState.deltaLastBroadcastText.set(effectiveRunKey, mergedText);
    chatRunState.deltaLastBroadcastLen.set(effectiveRunKey, mergedText.length);
    const payload = {
      runId: effectiveRunKey,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text: mergedText }],
        timestamp: now,
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveBufferedChatTextState = (effectiveRunKey: string, sourceRunId: string) => {
    const bufferedText = stripInlineDirectiveTagsForDisplay(
      chatRunState.buffers.get(effectiveRunKey) ?? "",
    ).text.trim();
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: effectiveRunKey,
      sourceRunId,
      text: bufferedText,
    });
    const text = normalizedHeartbeatText.text.trim();
    const shouldSuppressSilent =
      normalizedHeartbeatText.suppress || isSilentReplyText(text, SILENT_REPLY_TOKEN);
    return { text, shouldSuppressSilent };
  };

  const flushBufferedChatDeltaIfNeeded = (
    sessionKey: string,
    effectiveRunKey: string,
    sourceRunId: string,
    seq: number,
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(
      effectiveRunKey,
      sourceRunId,
    );
    const shouldSuppressSilentLeadFragment = isSilentReplyLeadFragment(text);
    const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(
      effectiveRunKey,
      sourceRunId,
    );
    if (
      !text ||
      shouldSuppressSilent ||
      shouldSuppressSilentLeadFragment ||
      shouldSuppressHeartbeatStreaming
    ) {
      return;
    }

    const lastBroadcastText = chatRunState.deltaLastBroadcastText.get(effectiveRunKey) ?? "";
    if (text === lastBroadcastText) {
      return;
    }

    const now = Date.now();
    const flushPayload = {
      runId: effectiveRunKey,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    broadcast("chat", flushPayload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", flushPayload);
    chatRunState.deltaLastBroadcastText.set(effectiveRunKey, text);
    chatRunState.deltaLastBroadcastLen.set(effectiveRunKey, text.length);
    chatRunState.deltaSentAt.set(effectiveRunKey, now);
  };

  const emitChatFinal = (
    sessionKey: string,
    effectiveRunKey: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
    stopReason?: string,
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(
      effectiveRunKey,
      sourceRunId,
    );
    // Flush any throttled delta so streaming clients receive the complete text
    // before the final event. The 150 ms throttle in emitChatDelta may have
    // suppressed the most recent chunk, leaving the client with stale text.
    // Only flush if the buffered text differs from the last broadcast to avoid duplicates.
    flushBufferedChatDeltaIfNeeded(sessionKey, effectiveRunKey, sourceRunId, seq);
    clearEffectiveChatRunState(chatRunState, effectiveRunKey);
    if (jobState === "done") {
      const payload = {
        runId: effectiveRunKey,
        sessionKey,
        seq,
        state: "final" as const,
        ...(stopReason && { stopReason }),
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: effectiveRunKey,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    // `effectiveRunKey` is the client-visible run identity used for chat merge
    // state. `evt.runId` remains the upstream source run id used for agent
    // context lookups and tool recipient routing.
    const effectiveRunKey = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = effectiveRunKey;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const isPendingRestartStartSignal =
      lifecyclePhase === "start" || evt.stream === "assistant" || evt.stream === "tool";
    const isAuthorizedPendingRestart =
      isPendingRestartStartSignal &&
      chatRunState.pendingRestartEffectiveRunKeys.has(effectiveRunKey) &&
      chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.get(effectiveRunKey) === evt.runId;
    const minEventTs = chatRunState.minEventTsByEffectiveRunKey.get(effectiveRunKey);
    if (typeof minEventTs === "number" && Number.isFinite(minEventTs)) {
      const eventTs = Number.isFinite(evt.ts) ? evt.ts : Date.now();
      if (eventTs < minEventTs) {
        return;
      }
    }

    // Prevent post-terminal state resurrection: finalized keys reopen only
    // when chat.send has a pending restart and the new source run actually
    // emits its first trusted client-visible event.
    if (chatRunState.finalizedEffectiveRunKeys.has(effectiveRunKey)) {
      if (!isAuthorizedPendingRestart) {
        return;
      }
    }
    if (isAuthorizedPendingRestart) {
      clearEffectiveChatRunState(chatRunState, effectiveRunKey);
    }

    const isAborted =
      chatRunState.abortedRuns.has(effectiveRunKey) || chatRunState.abortedRuns.has(evt.runId);
    const previousSeenEventSeq = chatRunState.lastSeenEventSeq.get(effectiveRunKey) ?? 0;
    const hasNumericSeq = Number.isFinite(evt.seq);
    if (hasNumericSeq && evt.seq > previousSeenEventSeq) {
      chatRunState.lastSeenEventSeq.set(effectiveRunKey, evt.seq);
    }
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const previousAgentRunSeq = agentRunSeq.get(effectiveRunKey);
    const last =
      typeof previousAgentRunSeq === "number" && Number.isFinite(previousAgentRunSeq)
        ? previousAgentRunSeq
        : 0;
    const isToolEvent = evt.stream === "tool";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload: strip result/partialResult unless verbose=full
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (hasNumericSeq && last > 0 && evt.seq !== last + 1) {
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    if (hasNumericSeq) {
      agentRunSeq.set(effectiveRunKey, Math.max(last, evt.seq));
    }
    if (isToolEvent) {
      const toolPhase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      // Flush pending assistant text before tool-start events so clients can
      // render complete pre-tool text above tool cards (not truncated by delta throttle).
      if (toolPhase === "start" && isControlUiVisible && sessionKey && !isAborted) {
        flushBufferedChatDeltaIfNeeded(sessionKey, effectiveRunKey, evt.runId, evt.seq);
      }
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients && recipients.size > 0) {
        broadcastToConnIds("agent", toolPayload, recipients);
      }
      // Session subscribers power operator UIs that attach to an existing
      // in-flight session after the run has already started. Those clients do
      // not know the runId in advance, so they cannot register as run-scoped
      // tool recipients. Mirror tool lifecycle onto a session-scoped event so
      // they can render live pending tool cards without polling history.
      if (sessionKey) {
        const sessionSubscribers = sessionEventSubscribers.getAll();
        if (sessionSubscribers.size > 0) {
          broadcastToConnIds("session.tool", toolPayload, sessionSubscribers, { dropIfSlow: true });
        }
      }
    } else {
      broadcast("agent", agentPayload);
    }

    if (isControlUiVisible && sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
      }
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        emitChatDelta({
          sessionKey,
          effectiveRunKey,
          sourceRunId: evt.runId,
          seq: evt.seq,
          text: evt.data.text,
          previousSeenEventSeq,
          delta: evt.data.delta,
        });
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        const evtStopReason =
          typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            evtStopReason,
          );
        } else {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            evtStopReason,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        // Keep aborted-run cleanup explicit: abortedRuns may be keyed by both
        // the source runId and the effective client-visible runId.
        chatRunState.abortedRuns.delete(effectiveRunKey);
        chatRunState.abortedRuns.delete(evt.runId);
        clearEffectiveChatRunState(chatRunState, effectiveRunKey);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, effectiveRunKey, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(effectiveRunKey);
      clearEffectiveChatRunState(chatRunState, effectiveRunKey);
      chatRunState.finalizedEffectiveRunKeys.set(effectiveRunKey, Date.now());
    }

    if (
      sessionKey &&
      (lifecyclePhase === "start" || lifecyclePhase === "end" || lifecyclePhase === "error")
    ) {
      void persistGatewaySessionLifecycleEvent({ sessionKey, event: evt }).catch(() => undefined);
      const sessionEventConnIds = sessionEventSubscribers.getAll();
      if (sessionEventConnIds.size > 0) {
        broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            phase: lifecyclePhase,
            runId: evt.runId,
            ts: evt.ts,
            ...buildSessionEventSnapshot(sessionKey, evt),
          },
          sessionEventConnIds,
          { dropIfSlow: true },
        );
      }
    }
  };
}
