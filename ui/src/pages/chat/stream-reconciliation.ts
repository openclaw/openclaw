import {
  projectSessionTerminalReplyMessage,
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  trimAccumulatedStreamPrefix,
} from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isKeyedAssistantStreamFallbackMessage } from "./chat-thread-run-identity.ts";
import {
  lastUserMessageIndex,
  streamCausalInsertIndex,
  streamCausalInterval,
  type StreamCausalBoundaryState,
} from "./stream-causal-boundary.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";
import type { ToolStreamState } from "./tool-stream-contract.ts";
import {
  createSegmentToolRefReader,
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";

type StreamReconciliationState = StreamCausalBoundaryState &
  ToolStreamState & {
    chatStream: string | null;
    chatStreamStartedAt: number | null;
  };

export type ToolStreamReconciliationState = StreamReconciliationState;

type VisibleAssistantStreamPart = {
  afterUserSendId?: string;
  text: string;
  replacementText: string;
  source: "segment" | "current";
  timestamp: number;
  itemId?: string;
  runId?: string;
  toolCallId?: string;
};

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;
type MaterializeVisibleStreamOptions = {
  includeCurrent?: boolean;
  requirePersistedTool?: boolean;
  replacementMessages?: unknown[];
  persistCommentary?: boolean;
  isHiddenAssistantMessage: AssistantMessageVisibility;
  isHiddenStreamText: StreamVisibility;
};

export function appendTerminalAssistantMessage(messages: unknown[], message: unknown): unknown[] {
  const identity = readSessionMessageIdentity(message);
  const terminalRunId =
    (identity?.role === "assistant" ? identity.runId : null) ?? readLiveTerminalRunId(message);
  const interval = streamCausalInterval(messages, terminalRunId ?? undefined);
  const terminalText = extractText(projectSessionTerminalReplyMessage(message))?.trim() ?? "";
  const retained = messages.slice(0, interval.start);
  let insertion: number | undefined;
  let soleCurrent: number | null | undefined;
  let tail = terminalText;
  for (let index = interval.start; index < interval.end; index++) {
    const existing = messages[index];
    const fallback = asNullableRecord(asNullableRecord(existing)?.openclawStreamFallback);
    if (fallback && !normalizeOptionalString(fallback.itemId)) {
      if (fallback.source === "current") {
        soleCurrent = soleCurrent === undefined ? retained.length : null;
      }
      const text = extractText(existing)?.trim();
      if (text && tail.startsWith(text)) {
        insertion ??= retained.length;
        tail = tail.slice(text.length).trimStart();
        continue;
      }
    }
    retained.push(existing);
  }
  // A lone current fallback can be replaced even if the final was rewritten.
  if (insertion === undefined && soleCurrent != null) {
    retained[soleCurrent] = message;
  } else {
    retained.splice(insertion ?? retained.length, 0, message);
  }
  return retained.concat(messages.slice(interval.end));
}

function visibleAssistantStreamText(
  stream: string | null,
  isHiddenStreamText: StreamVisibility,
): string | null {
  if (!stream?.trim() || isHiddenStreamText(stream)) {
    return null;
  }
  return stream;
}

export function visibleAssistantStreamParts(
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "includeCurrent" | "isHiddenStreamText">,
  liveToolRefs = resolveLiveToolStreamRefs(state),
): VisibleAssistantStreamPart[] {
  const parts: VisibleAssistantStreamPart[] = [];
  let previousText: string | null = null;
  const segments = state.chatStreamSegments;
  const readToolRef = createSegmentToolRefReader(liveToolRefs);
  for (const segment of segments) {
    const { itemId, callId, runId, indexed } = readToolRef(segment);
    const visible = visibleAssistantStreamText(
      itemId ? segment.text : trimAccumulatedStreamPrefix(segment.text, previousText),
      opts.isHiddenStreamText,
    );
    if (visible && segment.persisted !== true) {
      parts.push({
        text: visible,
        replacementText: segment.text,
        source: "segment",
        timestamp: asFiniteNumber(segment.ts) ?? Date.now(),
        itemId,
        runId: runId ?? indexed?.runId,
        toolCallId: callId ?? indexed?.id,
        afterUserSendId: segment.afterUserSendId,
      });
    }
    if (!itemId) {
      previousText = advanceAccumulatedStreamText(previousText, segment.text);
    }
  }
  if (opts.includeCurrent !== false && typeof state.chatStream === "string") {
    const visible = visibleAssistantStreamText(
      trimAccumulatedStreamPrefix(state.chatStream, previousText),
      opts.isHiddenStreamText,
    );
    if (visible) {
      parts.push({
        text: visible,
        replacementText: state.chatStream,
        source: "current",
        timestamp: state.chatStreamStartedAt ?? Date.now(),
        runId: state.chatRunId ?? undefined,
      });
    }
  }
  return parts;
}

export function visibleCurrentAssistantStreamTail(
  state: StreamReconciliationState,
  isHiddenStreamText: StreamVisibility,
): string | null {
  if (typeof state.chatStream !== "string") {
    return null;
  }
  const segments = state.chatStreamSegments;
  const previousText = accumulatedStreamText(segments);
  return visibleAssistantStreamText(
    trimAccumulatedStreamPrefix(state.chatStream, previousText),
    isHiddenStreamText,
  );
}

function hasAssistantStreamPartReplacement(
  messages: unknown[],
  part: VisibleAssistantStreamPart,
  isHiddenAssistantMessage: AssistantMessageVisibility,
  interval = streamCausalInterval(messages, part.runId),
): boolean {
  const rows = messages.slice(interval.start, interval.end);
  if (part.itemId) {
    return rows.some((message) => {
      const identity = readAssistantStreamSegmentIdentity(message);
      // Native commentary can lack run metadata; the caller's causal interval
      // still bounds that item, but known opposing runs must never replace it.
      return (
        identity !== undefined &&
        identity.itemId === part.itemId &&
        (!identity.runId || !part.runId || identity.runId === part.runId)
      );
    });
  }
  const persistedTexts = rows.map((message) => {
    const identity = readSessionMessageIdentity(message);
    if (
      (identity?.role && identity.role !== "assistant") ||
      (identity?.runId && part.runId && identity.runId !== part.runId) ||
      isHiddenAssistantMessage(message) ||
      isKeyedAssistantStreamFallbackMessage(message)
    ) {
      return null;
    }
    return extractText(message)?.trim() ?? null;
  });
  return [part.replacementText, part.text].some((text) => {
    const candidate = text.trim();
    if (!candidate) {
      return false;
    }
    let tail = candidate;
    for (const saved of persistedTexts) {
      if (!saved) {
        continue;
      }
      if (saved.startsWith(tail)) {
        return true;
      }
      if (tail.startsWith(saved)) {
        tail = tail.slice(saved.length).trimStart();
      } else if (tail !== candidate) {
        break;
      }
    }
    return false;
  });
}

function hasVisibleAssistantMessageAfterUser(
  messages: unknown[],
  isHiddenAssistantMessage: AssistantMessageVisibility,
): boolean {
  const startIndex = lastUserMessageIndex(messages) + 1;
  return messages.slice(startIndex).some((message) => {
    const role = normalizeLowercaseStringOrEmpty(asNullableRecord(message)?.role);
    if (role !== "assistant" || isHiddenAssistantMessage(message)) {
      return false;
    }
    return Boolean(extractText(message)?.trim());
  });
}

export function historyReplacedVisibleStream(
  messages: unknown[],
  parts: VisibleAssistantStreamPart[],
  opts: Pick<MaterializeVisibleStreamOptions, "isHiddenAssistantMessage" | "persistCommentary">,
): boolean {
  const required = opts.persistCommentary ? parts : parts.filter((part) => !part.itemId);
  return (
    parts.length > 0 &&
    (required.length > 0 ||
      hasVisibleAssistantMessageAfterUser(messages, opts.isHiddenAssistantMessage)) &&
    required.every((part) =>
      hasAssistantStreamPartReplacement(messages, part, opts.isHiddenAssistantMessage),
    )
  );
}

export function terminalMessageReplacesVisibleStream(
  message: unknown,
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "isHiddenStreamText">,
): boolean {
  const terminalText = extractText(projectSessionTerminalReplyMessage(message))?.trim();
  if (!terminalText) {
    return false;
  }
  let end: number | undefined;
  for (const part of visibleAssistantStreamParts(state, {
    isHiddenStreamText: opts.isHiddenStreamText,
  })) {
    if (part.itemId) {
      continue;
    }
    const text = part.text.trim();
    const index = terminalText.indexOf(text, end);
    // The first unkeyed part must open the terminal; every later part follows in order.
    if (index < 0 || (end === undefined && index !== 0)) {
      return false;
    }
    end = index + text.length;
  }
  return end !== undefined;
}

function messageTimestampMs(message: unknown): number | null {
  const record = asNullableRecord(message);
  return asFiniteNumber(record?.timestamp) ?? asFiniteNumber(record?.ts) ?? null;
}

export function materializeVisibleStreamState(
  messages: unknown[],
  state: StreamReconciliationState,
  opts: MaterializeVisibleStreamOptions,
): unknown[] {
  let nextMessages = messages;
  const persistCommentary = opts.persistCommentary === true;
  const replacementMessages = opts.replacementMessages;
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  for (const part of visibleAssistantStreamParts(state, opts, liveToolRefs)) {
    if (!persistCommentary && part.itemId) {
      continue;
    }
    const replacementCandidates = replacementMessages?.length
      ? [...nextMessages, ...replacementMessages]
      : nextMessages;
    const replacementInterval = streamCausalInterval(replacementCandidates, part.runId);
    if (
      hasAssistantStreamPartReplacement(
        replacementCandidates,
        part,
        opts.isHiddenAssistantMessage,
        replacementInterval,
      )
    ) {
      continue;
    }
    const interval =
      replacementCandidates === nextMessages && !part.afterUserSendId
        ? replacementInterval
        : streamCausalInterval(nextMessages, part.runId, part.afterUserSendId);
    let toolIndex = -1;
    if (part.source === "segment" && part.toolCallId) {
      const selectedToolIdentity = resolveMatchingLiveToolIdentity(
        { id: part.toolCallId, runId: part.runId },
        liveToolRefs,
      );
      if (selectedToolIdentity) {
        for (let index = interval.start; index < interval.end; index++) {
          if (
            extractToolMessageRefs(nextMessages[index]).some(
              (ref) => resolveMatchingLiveToolIdentity(ref, liveToolRefs) === selectedToolIdentity,
            )
          ) {
            toolIndex = index;
            break;
          }
        }
      }
    }
    if (opts.requirePersistedTool && toolIndex < 0) {
      continue;
    }
    // The call is an upper bound; earlier commentary must stay before a steer.
    const insertIndex =
      part.source === "segment"
        ? streamCausalInsertIndex(
            nextMessages,
            part.timestamp,
            interval.start,
            toolIndex >= 0 ? toolIndex : interval.end,
            messageTimestampMs,
          )
        : interval.end;
    let afterSequence: number | null | undefined;
    for (let i = insertIndex - 1; i >= 0 && afterSequence == null; i--) {
      afterSequence = readSessionMessageIdentity(nextMessages[i])?.sequence;
    }
    const streamMessage = {
      role: "assistant",
      content: [{ type: "text", text: part.text }],
      // User intervals own placement; retiming the saved stream would reorder live tools.
      timestamp: part.timestamp,
      openclawStreamFallback: {
        replacementText: part.replacementText,
        source: part.source,
        ...(part.itemId ? { itemId: part.itemId } : {}),
        ...(part.runId ? { runId: part.runId } : {}),
        ...(afterSequence == null ? {} : { afterSequence }),
      },
    };
    nextMessages = nextMessages.toSpliced(insertIndex, 0, streamMessage);
  }
  return nextMessages;
}
