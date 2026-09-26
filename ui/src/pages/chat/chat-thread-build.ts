import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import {
  type ChatGuardianNotice,
  type ChatItem,
  type MessageGroup,
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  canvasPreviewsMatch,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import type { CanvasToolPreview } from "../../lib/chat/tool-cards.ts";
import {
  buildCompactionDividerItem,
  buildGuardianNoticeItem,
  buildResetDividerItem,
  clearWorkingProgress,
  isContextCompactionMessage,
  matchesCompactionOperation,
  resolveWorkingProgress,
  shouldRenderQueuedSendInThread,
} from "./chat-progress.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import {
  placeChatInputs,
  type ChatInputOrderState,
  type ChatInputPlacementProps,
} from "./chat-thread-inputs.ts";
import {
  appendCanvasBlockToAssistantMessage,
  buildMessageItems,
  canvasPreviewBaseIdentity,
  createCanvasAssistantMessage,
  extractChatMessagePreview,
  findCanvasInsertionIndex,
  findNearestAssistantMessage,
  hasRenderableNormalizedMessage,
  insertionIndexesForBounds,
  type ChatProjection,
  messageMatchesSearchQuery,
  rawMessageTimestamp,
  insertChatItemsByTimestamp,
  sanitizeStreamText,
  timestampAfterVisibleItems,
  userTurnRunId,
  transcriptPositionTimestamp,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import {
  applyPersistedToolInvocationBounds,
  findCurrentTurnBounds,
  createRunTurnLookup,
  createToolCallLookup,
  isKeyedAssistantStreamFallbackMessage,
  optionalBoundaryIdentity,
  optionalRunIdentity,
  resolveRunInsertionBounds,
  transcriptRunId,
} from "./chat-thread-run-identity.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { latestPersistedSteerBoundary } from "./stream-causal-boundary.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";

export type BuildChatItemsProps = ChatInputPlacementProps & {
  paneId: string;
  sessionKey: string;
  archiveNotice?: Extract<ChatItem, { kind: "notice" }>;
  runId?: string | null;
  compactionStatus?: CompactionStatus | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
};

function canvasAssistantItemKey(
  message: unknown,
  source: Parameters<typeof canvasPreviewBaseIdentity>[1],
  fallback: string,
): string {
  const identity = canvasPreviewBaseIdentity(message, source);
  return identity ? `canvas:${identity}` : `${fallback}:canvas`;
}

export function buildChatItems(
  props: BuildChatItemsProps,
  inputOrder: ChatInputOrderState = { keys: [] },
): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const tools = props.toolMessages.filter(
    (message): message is Record<string, unknown> => asRecord(message) !== null,
  );
  const toolItems = buildMessageItems(tools).map((item) => {
    const projection: ChatProjection<typeof item> = { item };
    return {
      projection,
      runId: normalizeOptionalString(item.message.runId),
      callId: normalizeOptionalString(item.message.toolCallId),
      preview: extractChatMessagePreview(item.message),
    };
  });
  const queuedSends = props.queue ?? [];
  const segments = props.streamSegments;
  let progress: ReturnType<typeof resolveWorkingProgress> | null = null;
  const resolveProgress = () =>
    (progress ??= resolveWorkingProgress(
      props.sessionKey,
      props.runId ?? null,
      props.streamStartedAt,
      queuedSends,
      segments,
      tools,
    ));
  // Retention and live status share the same explicit or inferred run ownership.
  const activeCommentaryRunId =
    props.persistCommentary === false && (props.runWorking || props.runActive)
      ? normalizeOptionalString(resolveProgress().runId)
      : undefined;
  const history = composeTranscriptDisplay(
    props.messages.filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false ||
          !isKeyedAssistantStreamFallbackMessage(message) ||
          (activeCommentaryRunId !== undefined &&
            transcriptRunId(message) === activeCommentaryRunId)),
    ),
  );
  const searchFiltering = props.searchOpen === true && Boolean(props.searchQuery?.trim());
  const hiddenHistoryKeys = new Set<string>();
  const persistedCanvasIdentities = new Set<string>();
  const normalizedHistory = history.map(safeNormalizeMessage);
  const historyItems = buildMessageItems(history);
  let canvasTurn: {
    previews: { preview: CanvasToolPreview; item: (typeof historyItems)[number] }[];
    lastMatchingAssistantIndex: number;
  } = {
    previews: [],
    lastMatchingAssistantIndex: -1,
  };
  // Rows in one turn share these facts so a tool result can see the assistant
  // projection that follows it, without consuming a view from another turn.
  const canvasTurns = historyItems.map((item, index) => {
    const message = normalizedHistory[index];
    const role = message && normalizeRoleForGrouping(message.role);
    if (role === "user" || role === "system") {
      canvasTurn = { previews: [], lastMatchingAssistantIndex: -1 };
    }
    if (
      role === "assistant" &&
      message &&
      (!searchFiltering ||
        messageMatchesSearchQuery(history[index], props.searchQuery ?? "", props.messageRecovery))
    ) {
      canvasTurn.lastMatchingAssistantIndex = index;
      canvasTurn.previews.push(
        ...message.content.flatMap((block) =>
          block.type === "canvas" ? [{ preview: block.preview, item }] : [],
        ),
      );
    }
    return canvasTurn;
  });
  const compaction = props.compactionStatus;
  const compactionKey = compaction
    ? `divider:compaction:live:${compaction.runId}:${compaction.itemId ?? "manual"}`
    : undefined;
  let hasPersistedCompaction = false;
  for (const [i, item] of historyItems.entries()) {
    const msg = item.message;
    const itemKey = item.key;
    const raw = asRecord(msg) ?? {};
    const marker = asRecord(raw["__openclaw"]);
    if (marker?.kind === "compaction" || isContextCompactionMessage(msg)) {
      const matchesLive = compaction != null && matchesCompactionOperation(msg, compaction);
      const divider = buildCompactionDividerItem(
        marker ?? {},
        rawMessageTimestamp(msg) ?? Date.now(),
        i,
      );
      items.push({
        ...divider,
        compactionId: divider.key,
        ...(matchesLive && compactionKey ? { key: compactionKey } : {}),
      });
      hasPersistedCompaction ||= matchesLive;
      continue;
    }
    const normalized = normalizedHistory[i];
    if (!normalized) {
      continue;
    }
    if (marker && marker.kind === "reset") {
      items.push(buildResetDividerItem(marker, normalized.timestamp ?? Date.now(), i));
      continue;
    }

    const role = normalizeRoleForGrouping(normalized.role);
    if (role === "system") {
      const text = extractTextCached(msg);
      if (text?.trim()) {
        items.push({ kind: "notice", key: itemKey, text, timestamp: normalized.timestamp });
      }
      continue;
    }

    const isToolResult = normalized.role.toLowerCase() === "toolresult";
    const persistedCanvasSource = isToolResult ? extractChatMessagePreview(msg) : null;
    if (persistedCanvasSource) {
      const identity = canvasPreviewBaseIdentity(msg, persistedCanvasSource);
      if (identity) {
        persistedCanvasIdentities.add(identity);
      }
    }
    const matchingCanvas =
      persistedCanvasSource &&
      canvasTurns[i]!.previews.find(({ preview }) =>
        canvasPreviewsMatch(preview, persistedCanvasSource.preview),
      );
    if (persistedCanvasSource && matchingCanvas) {
      // Enrich the owned display row, including a later assistant shortcode,
      // without changing transcript input or introducing a second widget card.
      matchingCanvas.item.message = appendCanvasBlockToAssistantMessage(
        matchingCanvas.item.message,
        persistedCanvasSource.preview,
        persistedCanvasSource.text,
      );
    }
    const renderPersistedPreview =
      persistedCanvasSource != null &&
      !matchingCanvas &&
      (!searchFiltering || canvasTurns[i]!.lastMatchingAssistantIndex > i);
    if (persistedCanvasSource && renderPersistedPreview) {
      items.push({
        kind: "message",
        key: canvasAssistantItemKey(msg, persistedCanvasSource, itemKey),
        message: createCanvasAssistantMessage(
          persistedCanvasSource,
          persistedCanvasSource.timestamp ?? transcriptPositionTimestamp(history, i),
        ),
      });
    }

    if (!props.showToolCalls && isToolResult) {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(msg, searchQuery, props.messageRecovery)
    ) {
      hiddenHistoryKeys.add(itemKey);
    }
    if (
      !hasRenderableNormalizedMessage(msg, normalized) &&
      normalized.role.toLowerCase() !== "assistant"
    ) {
      continue;
    }

    items.push(...projectChatSystemNotice(item, normalized));
  }
  const currentRunId =
    props.runId ??
    (props.stream !== null || queuedSends.some(shouldRenderQueuedSendInThread)
      ? resolveProgress().runId
      : null);
  const historyTurnBounds = findCurrentTurnBounds(
    items.filter((item) => !hiddenHistoryKeys.has(item.key)),
  );
  const { pendingKeys, historicalKeys, hiddenKeys, activeInputKey } = placeChatInputs(
    items,
    history,
    props,
    inputOrder,
    currentRunId,
  );
  items = items.filter((item) => !hiddenHistoryKeys.has(item.key) && !hiddenKeys.has(item.key));
  const executionItems = () => items.filter((item) => !historicalKeys.has(item.key));
  const canvasRunBounds = createRunTurnLookup(executionItems());
  const currentTurnBounds =
    (currentRunId ? canvasRunBounds(currentRunId) : null) ??
    (activeInputKey ? { afterKey: activeInputKey } : historyTurnBounds);
  const boundToPendingInputs = (
    bounds: TurnInsertionBounds | null | undefined,
  ): TurnInsertionBounds | undefined => {
    const { minimum, maximum } = insertionIndexesForBounds(items, bounds ?? undefined);
    const pending = items.find(
      (item, index) => index >= minimum && index < maximum && pendingKeys.has(item.key),
    );
    return pending ? { ...bounds, beforeKey: pending.key } : (bounds ?? undefined);
  };
  for (const { projection, preview } of toolItems) {
    if (!preview) {
      continue;
    }
    const baseIdentity = canvasPreviewBaseIdentity(projection.item.message, preview);
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const canvasBounds = boundToPendingInputs(
      resolveRunInsertionBounds(
        canvasRunBounds,
        projection.item.message.runId,
        currentRunId,
        currentTurnBounds,
      ) ?? (!projection.item.message.runId && activeInputKey ? currentTurnBounds : undefined),
    );
    const { minimum: canvasMinimumIndex, maximum: canvasMaximumIndex } = insertionIndexesForBounds(
      items,
      canvasBounds ?? undefined,
    );
    const assistant = findNearestAssistantMessage(
      items,
      preview.timestamp,
      canvasMinimumIndex,
      canvasMaximumIndex,
    );
    if (assistant) {
      items[assistant.index] = {
        ...assistant.item,
        message: appendCanvasBlockToAssistantMessage(
          assistant.item.message,
          preview.preview,
          preview.text,
        ),
      };
      continue;
    }
    if (searchFiltering) {
      continue;
    }
    const insertionIndex = findCanvasInsertionIndex(
      items,
      preview.timestamp,
      canvasMinimumIndex,
      canvasMaximumIndex,
    );
    const nextItem = items[insertionIndex];
    const nextTimestamp =
      nextItem?.kind === "message" ? rawMessageTimestamp(nextItem.message) : null;
    const timestamp =
      preview.timestamp != null && nextTimestamp != null
        ? Math.min(preview.timestamp, nextTimestamp)
        : preview.timestamp;
    items.splice(insertionIndex, 0, {
      kind: "message",
      key: canvasAssistantItemKey(projection.item.message, preview, projection.item.key),
      message: createCanvasAssistantMessage(preview, timestamp),
    });
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const projections: ChatProjection[] = [];
  if (compaction && compactionKey && !hasPersistedCompaction) {
    const timestamp = compaction.startedAt ?? compaction.completedAt ?? Date.now();
    projections.push({
      item: {
        ...buildCompactionDividerItem(
          {},
          timestamp,
          0,
          compaction.phase === "complete" ? "complete" : "active",
        ),
        key: compactionKey,
      },
    });
  }
  const afterBoundaryBySegment = new Map<ChatStreamSegment, string>();
  let latestBoundaryRunId: string | undefined;
  for (const segment of segments) {
    const afterBoundaryRunId =
      normalizeOptionalString(segment.afterBoundaryRunId) ?? latestBoundaryRunId;
    if (afterBoundaryRunId) {
      afterBoundaryBySegment.set(segment, afterBoundaryRunId);
    }
    latestBoundaryRunId = normalizeOptionalString(segment.boundaryRunId) ?? latestBoundaryRunId;
  }
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter(
    (segment) => !streamSegmentHasItemId(segment) && segment.boundaryMarker !== true,
  );
  const toolLookup = createToolCallLookup<ChatProjection>();
  for (const tool of toolItems) {
    toolLookup.add(tool.runId, tool.callId, tool.projection);
  }
  // Empty user rows may have disappeared since canvas placement. Preserve the
  // earlier current-turn fallback, but resolve exact bounds over rendered rows.
  const projectionRunBounds = createRunTurnLookup(executionItems());
  const resolveProjectionBounds = (
    runId: unknown,
    boundaryRunId?: string,
    afterBoundaryRunId?: string,
  ): TurnInsertionBounds | undefined => {
    const bounds =
      resolveRunInsertionBounds(projectionRunBounds, runId, currentRunId, currentTurnBounds) ??
      (!runId && activeInputKey ? currentTurnBounds : undefined);
    const boundaryKey = boundaryRunId ? projectionRunBounds(boundaryRunId)?.afterKey : undefined;
    const afterBounds = afterBoundaryRunId ? projectionRunBounds(afterBoundaryRunId) : undefined;
    return boundToPendingInputs(
      bounds || boundaryKey || afterBounds
        ? {
            ...bounds,
            ...(afterBounds?.afterKey ? { afterKey: afterBounds.afterKey } : {}),
            ...(afterBounds?.beforeKey ? { beforeKey: afterBounds.beforeKey } : {}),
            ...(boundaryKey ? { beforeKey: boundaryKey } : {}),
          }
        : undefined,
    );
  };
  if (!searchFiltering) {
    if (props.archiveNotice) {
      projections.push({ item: props.archiveNotice });
    }
    for (const notice of props.guardianNotices ?? []) {
      projections.push({
        item: buildGuardianNoticeItem(notice),
        bounds: resolveProjectionBounds(notice.runId),
      });
    }
  }
  const toolBeforeBoundaries = createToolCallLookup<string>();
  const toolAfterBoundaries = createToolCallLookup<string>();
  for (const segment of indexedSegments) {
    const callId = normalizeOptionalString(segment.toolCallId);
    const runId = normalizeOptionalString(segment.runId);
    const boundaryRunId = normalizeOptionalString(segment.boundaryRunId);
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    if (boundaryRunId) {
      toolBeforeBoundaries.add(runId, callId, boundaryRunId);
    }
    if (afterBoundaryRunId) {
      toolAfterBoundaries.add(runId, callId, afterBoundaryRunId);
    }
  }
  const appendStreamSegment = (segment: ChatStreamSegment, key: string, text: string) => {
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    projections.push({
      item: {
        kind: "stream",
        key,
        text,
        startedAt: segment.ts,
        isStreaming: false,
        ...optionalRunIdentity(segment.runId),
        ...optionalBoundaryIdentity(afterBoundaryRunId ?? segment.runId),
      },
      bounds: resolveProjectionBounds(segment.runId, segment.boundaryRunId, afterBoundaryRunId),
    });
  };
  let previousAccumulatedStreamText: string | null = null;
  const maxLen = Math.max(indexedSegments.length, toolItems.length);
  for (let i = 0; i < maxLen; i++) {
    const segment = indexedSegments[i];
    if (segment) {
      const text = sanitizeStreamText(segment.text);
      const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
      const visibleText = usesAccumulatedText
        ? trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText)
        : text;
      if (usesAccumulatedText) {
        previousAccumulatedStreamText = advanceAccumulatedStreamText(
          previousAccumulatedStreamText,
          text,
        );
      }
      if (visibleText.length > 0 && segment.persisted !== true) {
        const streamKey = `stream-seg:${props.sessionKey}:${i}`;
        appendStreamSegment(segment, streamKey, visibleText);
        const tool = toolLookup.get(
          normalizeOptionalString(segment.runId),
          segment.toolCallId?.trim(),
        );
        if (tool) {
          // Gateway and browser clocks can disagree. Keep the assistant text that
          // introduced a tool causally before its card even when timestamps do not.
          tool.predecessorKey = streamKey;
        }
      }
    }
    const tool = toolItems[i];
    if (tool && props.showToolCalls) {
      const before = toolBeforeBoundaries.get(tool.runId, tool.callId);
      const after = toolAfterBoundaries.get(tool.runId, tool.callId);
      tool.projection.bounds = resolveProjectionBounds(tool.runId, before, after);
      projections.push(tool.projection);
    }
  }
  // Keyed commentary does not advance cumulative text and follows the indexed
  // stream/tool pairs on timestamp ties.
  for (const segment of keyedSegments) {
    const text = sanitizeStreamText(segment.text);
    if (text.length > 0) {
      appendStreamSegment(segment, `stream-seg:${props.sessionKey}:${segment.itemId}`, text);
    }
  }

  for (const prompt of props.questionPrompts ?? []) {
    // Pending questions live in the composer dock. Their terminal summaries are
    // timestamped transient projections, so keep their historical placement.
    if (prompt.status === "pending") {
      continue;
    }
    const questionItem: ChatItem = {
      kind: "question",
      key: `question:${prompt.id}`,
      questionId: prompt.id,
      startedAt: prompt.createdAtMs,
    };
    projections.push({
      item: questionItem,
      bounds: prompt.runId ? resolveProjectionBounds(prompt.runId) : undefined,
    });
  }

  // Unowned projections keep their user-turn floor despite clock skew;
  // identified live tools stay in the canonical invocation's interval.
  applyPersistedToolInvocationBounds(
    items,
    toolItems.map((tool) => tool.projection),
  );
  insertChatItemsByTimestamp(items, projections);

  // The active claw is telemetry, not a placeholder: it stays through visible
  // assistant text and tool cards until the run settles. The initial-load
  // skeleton still owns an otherwise empty thread, but not an active stream.
  const initialHistoryLoad = props.stream === null && props.loading === true && items.length === 0;
  // A non-null empty stream is the acknowledgement bridge before runWorking
  // catches up.
  const hasEmptyLiveStream = props.stream !== null && props.stream.trim().length === 0;
  const showWorkingIndicator =
    (!compaction || compaction.phase === "complete") &&
    ((props.runWorking === true && !initialHistoryLoad) ||
      hasEmptyLiveStream ||
      queuedSends.some(
        (item) =>
          (item.sendState === "submitting" || item.sendState === "sending") &&
          shouldRenderQueuedSendInThread(item),
      ));
  if (props.runWorking !== true && props.stream === null && !showWorkingIndicator) {
    clearWorkingProgress(props.sessionKey);
  }
  const persistedBoundary = currentRunId
    ? latestPersistedSteerBoundary(history, currentRunId)
    : null;
  const activeBoundaryRunId =
    persistedBoundary &&
    (!latestBoundaryRunId ||
      history.findIndex((message) => userTurnRunId(message) === latestBoundaryRunId) <=
        persistedBoundary.index)
      ? persistedBoundary.runId
      : latestBoundaryRunId;
  const activeTurnRunId = activeBoundaryRunId ?? currentRunId;
  const activeTurnBounds = boundToPendingInputs(
    (activeTurnRunId ? createRunTurnLookup(executionItems())(activeTurnRunId) : null) ??
      (activeInputKey ? { afterKey: activeInputKey } : null),
  );
  const appendActiveRunItem = (item: ChatItem) => {
    // Queued custody is a ceiling for the whole live response, not just its text.
    // Moving its working indicator past that ceiling splits and remeasures the run.
    if (activeTurnBounds) {
      const { maximum } = insertionIndexesForBounds(items, activeTurnBounds);
      items.splice(maximum, 0, item);
    } else {
      items.push(item);
    }
  };
  if (props.stream !== null) {
    const text = sanitizeStreamText(props.stream);
    const prefix = accumulatedStreamText(segments, sanitizeStreamText);
    const visibleText = trimAccumulatedStreamPrefix(text, prefix);
    if (visibleText.length > 0 && !stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
      const liveProgress = resolveProgress();
      const liveRunId = props.runId ?? liveProgress.runId;
      const liveStreamItem: ChatItem = {
        kind: "stream",
        key: activeBoundaryRunId
          ? `${liveProgress.key}:after:${activeBoundaryRunId}`
          : liveProgress.key,
        text: visibleText,
        startedAt: timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now()),
        isStreaming: true,
        ...optionalRunIdentity(liveRunId),
        ...optionalBoundaryIdentity(activeBoundaryRunId ?? liveRunId),
      };
      appendActiveRunItem(liveStreamItem);
    }
  }
  if (showWorkingIndicator) {
    const workingProgress = resolveProgress();
    const workingRunId = props.runId ?? workingProgress.runId;
    appendActiveRunItem({
      kind: "reading-indicator",
      key: workingProgress.key,
      startedAt: workingProgress.startedAt,
      ...optionalRunIdentity(workingRunId),
      ...optionalBoundaryIdentity(activeBoundaryRunId ?? workingRunId),
    });
  }
  return groupMessages(coalesceToolActivityMessages(items));
}
