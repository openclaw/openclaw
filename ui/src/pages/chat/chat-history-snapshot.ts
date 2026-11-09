import type { SessionProjectionEntry } from "@openclaw/gateway-client/browser";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChatInputReceipts,
  ChatHistoryParams,
  ChatPendingInputsPage,
  ChatHistoryActivity,
  ChatHistoryDeltaResult as ProtocolChatHistoryDeltaResult,
  ChatHistoryResetResult,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceIdentity,
  prependUniqueNativeMessages,
} from "../../lib/chat/history-message-identity.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination, ChatHistorySegment } from "./chat-history-pagination.ts";
import {
  invalidateChatHistoryPacketSources,
  extendChatHistoryWindow,
  prepareChatHistorySegment,
  chatHistoryReaderBridge,
  selectChatHistoryResidency,
} from "./chat-history-window.ts";
import { projectChatSessionStateSnapshot } from "./chat-session-state-snapshot.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import {
  readChatLocalOutputEntries,
  prepareChatHistoryProjectionMessages,
} from "./history-merge.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  readChatHistoryCursor,
  setChatHistoryCursor,
  projectChatTranscriptMetadata,
} from "./session-message-cache.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

export type ChatHistoryResult = {
  // Prepared locally by the response owner, never reconstructed from warm rows.
  packet?: ChatHistorySegment;
  stateRevision?: ChatHistoryState["stateRevision"];
  activity?: ChatHistoryActivity[];
  pendingInputs?: ChatPendingInputsPage;
  inputReceipts?: ChatInputReceipts;
  deltaCursor?: string;
  continuity?: NonNullable<ChatHistoryParams["continuity"]> & { accepted: boolean };
  windowReset?: boolean;
  messages?: Array<unknown>;
  offset?: number;
  nextOffset?: number;
  olderCursor?: string;
  newerCursor?: string;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  sessionInfoSnapshotAt?: number;
  metadata?: Partial<ChatMetadataResult>;
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    sessionAbortable?: boolean;
    events?: AgentEventPayload[];
    plan?: { steps: Array<{ step: string; status: string }>; explanation?: string };
  };
};

export type ChatHistoryDeltaResult = Omit<
  ProtocolChatHistoryDeltaResult,
  "sessionInfo" | "inFlightRun" | "metadata"
> & {
  sessionInfo?: GatewaySessionRow;
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  metadata?: Partial<ChatMetadataResult>;
};

export type { ChatHistoryResetResult };

export type ChatHistoryResponse =
  | ChatHistoryResult
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export type ChatHistoryObservation = {
  owner: ChatHistorySessions;
  reconcile: ReturnType<ChatHistorySessions["captureReconcile"]>;
  run?: ChatHistoryRunObservation;
};

export type ObservedChatHistoryResult = ChatHistoryResult & {
  observation: ChatHistoryObservation;
};

export type ObservedChatHistoryResponse = ChatHistoryResponse & {
  observation: ChatHistoryObservation;
};

export function isHistoryCursor(
  result: ChatHistoryResponse,
): result is ChatHistoryDeltaResult | ChatHistoryResetResult {
  return "kind" in result;
}

export function resolveChatHistoryPagination(
  result: ChatHistoryResult | undefined,
  totalMessages?: number,
): ChatHistoryPagination {
  const validTotal = asSafeIntegerInRange(result?.totalMessages ?? totalMessages, { min: 0 });
  const nextOffset = asSafeIntegerInRange(result?.nextOffset, { min: 1 });
  const olderCursor = normalizeNullableString(result?.olderCursor);
  const newerCursor = normalizeNullableString(result?.newerCursor);
  const newer = newerCursor ? { newerCursor, hasNewer: true as const } : {};
  if (result?.hasMore === true || olderCursor) {
    return {
      hasMore: true,
      ...newer,
      ...(olderCursor ? { olderCursor } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    };
  }
  return {
    hasMore: false,
    ...newer,
    ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    ...(result?.completeSnapshot === true ? { completeSnapshot: true as const } : {}),
  };
}

export function historySessionId(result: ChatHistoryResult): string | null {
  return (
    normalizeNullableString(result.sessionInfo?.sessionId) ??
    normalizeNullableString(result.sessionId)
  );
}

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = asSafeIntegerInRange(pagination.totalMessages, { min: 0 });
  if (totalMessages === undefined) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  if (retainedDepth === undefined) {
    return null;
  }
  const start = totalMessages - retainedDepth + 1;
  return asSafeIntegerInRange(start, { min: 1 }) ?? null;
}

export function reconcileHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination; retainedCoverage?: true } | null {
  if (!options.previousSessionId || options.previousSessionId !== options.nextSessionId) {
    return null;
  }
  if (options.previousPagination.hasNewer) {
    // A background tail refresh is not contiguous with a detached reader.
    // Latest explicitly resets this window; never stitch across the newer gap.
    return { messages: options.previousMessages, pagination: options.previousPagination };
  }
  const previousByIdentity = new Map<string, unknown[]>();
  const previousSources = new Set<string>();
  const changedSources = new Set<string>();
  for (const message of options.previousMessages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      previousSources.add(source);
    }
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      const matches = previousByIdentity.get(identity) ?? [];
      matches.push(message);
      previousByIdentity.set(identity, matches);
    }
  }
  // Identical history rows keep their render identity, including projected siblings.
  const messages = options.nextMessages.map((message) => {
    const identity = nativeHistoryMessageIdentity(message);
    const held = identity ? previousByIdentity.get(identity)?.shift() : undefined;
    const source = nativeHistoryMessageSourceIdentity(message);
    if (!held && source && previousSources.has(source)) {
      changedSources.add(source);
    }
    return held ?? message;
  });
  const reconciled = { messages, pagination: options.nextPagination };
  if (!options.nextPagination.hasMore) {
    return reconciled;
  }
  const previousTotal = options.previousPagination.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  if (previousTotal !== undefined && nextTotal !== undefined && nextTotal < previousTotal) {
    return reconciled;
  }
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  const firstSource = nativeHistoryMessageSourceIdentity(messages[0]);
  const overlap = firstSource
    ? options.previousMessages.findIndex(
        (message) => nativeHistoryMessageSourceIdentity(message) === firstSource,
      )
    : options.previousMessages.indexOf(messages[0]);
  // Matching source IDs prove overlap without interpreting native sequences as
  // CLI ordinals. An empty visible window needs authoritative raw coverage;
  // a hidden page still advances the admitted oldest edge.
  const adjoining =
    typeof previousTotal === "number" &&
    nextStart !== null &&
    (options.previousMessages.length === 0
      ? nextStart <= previousTotal + 1
      : nextStart === previousTotal + 1);
  if (overlap < 0 && !adjoining) {
    return reconciled;
  }
  const prefix =
    overlap >= 0 ? options.previousMessages.slice(0, overlap) : options.previousMessages;
  const unavailable =
    options.previousPagination.hasMore &&
    !options.previousPagination.olderCursor &&
    !options.previousPagination.needsBoundary;
  // A missing edge never certified traversal. A fresh edge covers this tail
  // only; any older held prefix must reopen its own source boundary.
  if (unavailable && prefix.length === 0) {
    return reconciled;
  }
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextOffset =
    previousStart !== null && typeof nextTotal === "number"
      ? nextTotal - previousStart + 1
      : undefined;
  const replacedSources = new Set(
    options.previousMessages.slice(prefix.length).map(nativeHistoryMessageSourceIdentity),
  );
  // Reuse occurrence matching above: removed or changed tail rows revoke every
  // retained packet alias before refreshed bodies enter resident selection.
  for (const remaining of previousByIdentity.values()) {
    const source = nativeHistoryMessageSourceIdentity(remaining[0]);
    if (source && replacedSources.has(source)) {
      changedSources.add(source);
    }
  }
  return {
    messages: [...prefix, ...messages],
    retainedCoverage: true,
    pagination: {
      ...invalidateChatHistoryPacketSources(options.previousPagination, changedSources),
      ...(unavailable ? { needsBoundary: true as const } : {}),
      ...(nextTotal !== undefined ? { totalMessages: nextTotal } : {}),
      ...(options.previousPagination.hasMore && nextOffset !== undefined ? { nextOffset } : {}),
    },
  };
}

/** Prepare packet coverage without acquiring producer observations or publishing. */
export function prepareChatHistoryPages(
  state: Pick<ChatState, "chatMessages" | "chatHistoryPagination" | "readTranscriptReaderSnapshot">,
  results: readonly ChatHistoryResult[],
  direction: "older" | "newer" | "around",
  localEntries: readonly SessionProjectionEntry[] = readChatLocalOutputEntries(state),
  previousView?: {
    messages: readonly unknown[];
    pagination: ChatHistoryPagination;
    reader?: import("./chat-history-pagination.ts").ChatTranscriptReaderSnapshot | null;
    scope?: import("@openclaw/gateway-client/browser").SessionProjectionScope;
  },
) {
  const localOutputs = localEntries.map((entry) => entry.message);
  const previous = previousView?.messages ?? state.chatMessages;
  const previousPagination = previousView?.pagination ?? state.chatHistoryPagination;
  const reader =
    previousView?.reader !== undefined
      ? previousView.reader
      : state.readTranscriptReaderSnapshot?.();
  const held = previousPagination.segments ?? [
    prepareChatHistorySegment(previous, previousPagination, previousPagination.newerCursor),
  ];
  const required = new Set(
    direction === "around"
      ? []
      : chatHistoryReaderBridge(
          previous,
          { ...previousPagination, segments: held },
          reader,
          direction,
        ),
  );
  let messages = previous;
  let coverage = previousPagination;
  const movement = direction === "around" ? "tail" : direction;
  for (const result of results) {
    const incoming = result.messages ?? [];
    for (const message of incoming) {
      const source = nativeHistoryMessageSourceIdentity(message);
      if (source) {
        required.add(source);
      }
    }
    let packet = result.packet;
    let next = incoming;
    if (direction !== "around") {
      const merged =
        direction === "older"
          ? prependUniqueNativeMessages(incoming, messages, localEntries)
          : prependUniqueNativeMessages(messages, incoming, localEntries);
      const heldExpanded =
        direction === "older" ? merged.currentExpandedSources : merged.incomingExpandedSources;
      const incomingExpanded =
        direction === "older" ? merged.incomingExpandedSources : merged.currentExpandedSources;
      coverage = invalidateChatHistoryPacketSources(coverage, heldExpanded);
      if (packet?.boundedPacket && packet.sources.some((source) => incomingExpanded.has(source))) {
        packet = { ...packet, boundedPacket: undefined };
      }
      next = merged.messages;
    }
    coverage = extendChatHistoryWindow(
      coverage,
      messages,
      incoming,
      resolveChatHistoryPagination(result, coverage.totalMessages),
      result.newerCursor,
      movement,
      undefined,
      packet,
    );
    messages = next;
  }
  const transformed = prepareChatHistoryProjectionMessages(state, messages, previousView?.scope);
  messages = transformed.messages;
  coverage = invalidateChatHistoryPacketSources(coverage, transformed.changedSources);
  const covered = new Set(coverage.segments?.flatMap((segment) => segment.sources));
  const pinned = new Set(transformed.pins.map(nativeHistoryMessageSourceIdentity));
  const visible = direction === "around" ? [] : (reader?.visibleSources ?? []);
  const knownVisible = visible.every((source) => covered.has(source) || pinned.has(source));
  const resident = selectChatHistoryResidency(
    messages,
    coverage,
    movement,
    reader?.anchor,
    localOutputs,
    { visibleSources: visible, pins: transformed.pins },
  );
  const retained = new Set(resident.pagination.segments?.flatMap((segment) => segment.sources));
  // Incoming sources and the actual reader bridge must survive together.
  return {
    messages,
    pagination: resident.pagination,
    requiredSources: required,
    fits:
      knownVisible &&
      [...required].every((source) => retained.has(source)) &&
      resident.withinBudget,
  };
}

export function commitCurrentChatHistorySnapshot(
  state: ChatState,
  deltaCursor?: string | null,
  sessionInfo?: GatewaySessionRow,
  historyState?: ChatHistoryState | null,
): void {
  if (deltaCursor !== undefined) {
    setChatHistoryCursor(state, deltaCursor ?? undefined);
  }
  const cachedDeltaCursor = readChatHistoryCursor(state);
  if (!state.chatMessagesBySession) {
    return;
  }
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const previous = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  const retained = previous?.sessionId === (state.currentSessionId ?? null) ? previous : undefined;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      ...(cachedDeltaCursor !== undefined ? { deltaCursor: cachedDeltaCursor } : {}),
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
      transcriptMetadata: sessionInfo
        ? projectChatTranscriptMetadata(sessionInfo)
        : retained?.transcriptMetadata,
      sessionState: sessionInfo
        ? projectChatSessionStateSnapshot(state, sessionInfo, retained?.sessionState)
        : retained?.sessionState,
      progressCard: retained?.progressCard,
      historyState:
        historyState === undefined ? retained?.historyState : (historyState ?? undefined),
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: state.currentSessionId ?? null,
    },
  );
}

export function clearHistoryCursor(state: ChatState, sessionKey: string, agentId?: string): void {
  delete state.chatHistoryCursor;
  if (!state.chatMessagesBySession) {
    return;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  if (snapshot?.deltaCursor === undefined && snapshot?.historyState === undefined) {
    return;
  }
  const { deltaCursor: _deltaCursor, historyState: _historyState, ...withoutCursor } = snapshot;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    withoutCursor,
  );
}
