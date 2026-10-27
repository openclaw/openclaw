import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readNodePermissionRequest } from "../../../../packages/gateway-protocol/src/node-permissions.js";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import { readModelFallbackNotice } from "../../../../src/shared/model-fallback-notice.js";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { t } from "../../i18n/index.ts";
import {
  type ChatGuardianNotice,
  type ChatItem,
  type MessageGroup,
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  canvasPreviewsMatch,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import { pluginInlineViewItems } from "../../lib/chat/plugin-inline-views.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
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
import { activeChatReasoning } from "./chat-reasoning.ts";
import { projectRunFailureStreaks } from "./chat-run-failure-streaks.ts";
import {
  hasHandoffToolCall,
  pendingSessionsYield,
  projectSessionsYieldItems,
} from "./chat-sessions-yield.ts";
import {
  createSubmittedModelNoticeProjector,
  projectChatSystemNotice,
} from "./chat-system-notice.ts";
import {
  canvasAssistantItemKey,
  collectCanvasTurns,
  reconcileLiveCanvasPreviews,
} from "./chat-thread-canvas.ts";
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
import type { ChatReasoning, CompactionStatus } from "./tool-stream-contract.ts";

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
  reasoning?: ChatReasoning | null;
  showReasoning?: boolean;
  stream: string | null;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** The answer is visible or the runtime only owns background settlement. */
  runFinalizing?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  /** Set while a run that handed off is idle and its subagents are still running. */
  subagentWait?: { startedAt: number; runId: string };
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  /** People the session row lists, loaded or not, keyed by `sessionParticipantIdentityKey`. */
  replyPeople?: readonly string[];
  /** Key of the signed-in viewer, who authors local user messages without a sender. */
  replyLocalPerson?: string;
};

export function buildChatItems(
  props: BuildChatItemsProps,
  inputOrder: ChatInputOrderState = { keys: [] },
): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const inlineInvocations = new Set<string>();
  const tools = props.toolMessages.filter(
    (message): message is Record<string, unknown> => asRecord(message) !== null,
  );
  const toolItems = buildMessageItems(tools).map((item) => {
    const projection: ChatProjection<typeof item> = {
      item,
    };
    return {
      projection,
      runId: normalizeOptionalString(item.message.runId),
      callId: normalizeOptionalString(item.message.toolCallId),
      preview: extractChatMessagePreview(item.message),
    };
  });
  const queuedSends = props.queue ?? [];
  const segments = props.streamSegments;
  const activeReasoning = activeChatReasoning(props.reasoning);
  let progress: ReturnType<typeof resolveWorkingProgress> | null = null;
  const resolveProgress = () => {
    if (progress) {
      return progress;
    }
    // A run that handed off has ended, but its live rows stay until the next
    // run starts. The status that follows must not take that run's identity or
    // count from its first tool call.
    const handedOff = props.runId ? undefined : pendingSessionsYield(props.messages)?.runId;
    progress = resolveWorkingProgress(
      props.sessionKey,
      props.runId ?? null,
      props.streamStartedAt,
      queuedSends,
      handedOff ? segments.filter((segment) => segment.runId !== handedOff) : segments,
      handedOff ? tools.filter((message) => message.runId !== handedOff) : tools,
    );
    return progress;
  };
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
  const hideSearchMiss = (item: Extract<ChatItem, { kind: "message" }>) => {
    if (
      searchFiltering &&
      !messageMatchesSearchQuery(item.message, props.searchQuery ?? "", props.messageRecovery)
    ) {
      hiddenHistoryKeys.add(item.key);
    }
  };
  const canvasIdentities = new Set<string>();
  const normalizedHistory = history.map(safeNormalizeMessage);
  const permissionInMessage = (message: unknown) =>
    extractToolCardsCached(message).some((card) =>
      readNodePermissionRequest(asRecord(card.details)?.permissionMissing),
    );
  const historyItems = buildMessageItems(history);
  const canvasTurns = collectCanvasTurns(
    historyItems,
    normalizedHistory,
    (message) =>
      !searchFiltering ||
      messageMatchesSearchQuery(message, props.searchQuery ?? "", props.messageRecovery),
  );
  const compaction = props.compactionStatus;
  const compactionKey = compaction
    ? `divider:compaction:live:${compaction.runId}:${compaction.itemId ?? "manual"}`
    : undefined;
  let hasPersistedCompaction = false;
  const projectSubmittedModel = createSubmittedModelNoticeProjector();
  for (const [i, item] of historyItems.entries()) {
    const msg = item.message;
    const itemKey = item.key;
    const raw = asRecord(msg) ?? {};
    const marker = asRecord(raw["__openclaw"]);
    const modelNotice = projectSubmittedModel(item);
    if (modelNotice) {
      items.push(modelNotice);
    }
    const fallback = readModelFallbackNotice(msg);
    if (fallback) {
      items.push({
        kind: "divider",
        key: `divider:model-fallback:${itemKey}`,
        systemEvent: "info",
        label: t(
          fallback.phase === "restored"
            ? "chat.composer.modelRestoredEvent"
            : "chat.composer.modelFallbackEvent",
          { from: fallback.fromModel, to: fallback.toModel },
        ),
        ...(fallback.reason
          ? {
              description: t("chat.composer.fallbackReason", {
                reason: fallback.reason.replace(/_/g, " "),
              }),
            }
          : {}),
        timestamp: rawMessageTimestamp(msg) ?? Date.now(),
      });
      continue;
    }
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

    for (const inline of pluginInlineViewItems(item, inlineInvocations)) {
      hideSearchMiss(inline);
      items.push(inline);
    }
    const isToolResult = normalized.role.toLowerCase() === "toolresult";
    const persistedCanvasSource = isToolResult ? extractChatMessagePreview(msg) : null;
    let duplicatePersistedCanvas = false;
    if (persistedCanvasSource) {
      const identity = canvasPreviewBaseIdentity(msg, persistedCanvasSource);
      if (identity) {
        duplicatePersistedCanvas = canvasIdentities.has(identity);
        canvasIdentities.add(identity);
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
      !duplicatePersistedCanvas &&
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

    if (
      !props.showToolCalls &&
      isToolResult &&
      !(raw.role === "assistant" && extractTextCached(msg)?.trim()) &&
      !hasHandoffToolCall(msg) &&
      !permissionInMessage(msg)
    ) {
      continue;
    }

    hideSearchMiss(item);
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
  const historyTurnBounds = findCurrentTurnBounds(items);
  const { pendingKeys, historicalKeys, hiddenKeys, activeInputKey } = placeChatInputs(
    items,
    history,
    props,
    inputOrder,
    currentRunId,
  );
  const executionItems = () => items.filter((item) => !historicalKeys.has(item.key));
  const canvasRunBounds = createRunTurnLookup(executionItems());
  const currentTurnBounds =
    (currentRunId ? canvasRunBounds(currentRunId) : null) ??
    (activeInputKey ? { afterKey: activeInputKey } : historyTurnBounds);
  const resolveRunBounds = (
    lookup: typeof canvasRunBounds,
    runId: unknown,
    afterUserSendId?: string,
  ) =>
    (typeof runId === "string" && afterUserSendId ? lookup(runId, afterUserSendId) : null) ??
    resolveRunInsertionBounds(lookup, runId, currentRunId, currentTurnBounds) ??
    (!runId && activeInputKey ? currentTurnBounds : undefined);
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
    if (baseIdentity) {
      if (canvasIdentities.has(baseIdentity)) {
        continue;
      }
      canvasIdentities.add(baseIdentity);
    }
    const canvasBounds = boundToPendingInputs(
      resolveRunBounds(
        canvasRunBounds,
        projection.item.message.runId,
        normalizeOptionalString(projection.item.message.openclawToolStreamAfterSendId),
      ),
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
  items = reconcileLiveCanvasPreviews(items, hiddenHistoryKeys, hiddenKeys);
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
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter((segment) => !streamSegmentHasItemId(segment));
  const toolLookup = createToolCallLookup<ChatProjection>();
  for (const tool of toolItems) {
    toolLookup.add(tool.runId, tool.callId, tool.projection);
  }
  // Empty user rows may have disappeared since canvas placement. Preserve the
  // earlier current-turn fallback, but resolve exact bounds over rendered rows.
  const projectionRunBounds = createRunTurnLookup(executionItems());
  const resolveProjectionBounds = (
    runId: unknown,
    afterUserSendId?: string,
  ): TurnInsertionBounds | undefined =>
    boundToPendingInputs(resolveRunBounds(projectionRunBounds, runId, afterUserSendId));
  if (!searchFiltering) {
    const recordedPermissions = new Set(
      props.guardianNotices?.some((notice) => notice.permissionMissing)
        ? [...props.messages, ...props.toolMessages].flatMap((message) =>
            extractToolCardsCached(message).flatMap((card) => {
              const request = readNodePermissionRequest(asRecord(card.details)?.permissionMissing);
              return request ? [JSON.stringify(request)] : [];
            }),
          )
        : [],
    );
    if (props.archiveNotice) {
      projections.push({ item: props.archiveNotice });
    }
    for (const notice of props.guardianNotices ?? []) {
      if (
        notice.permissionMissing &&
        recordedPermissions.has(JSON.stringify(notice.permissionMissing))
      ) {
        continue;
      }
      projections.push({
        item: buildGuardianNoticeItem(notice),
        bounds: resolveProjectionBounds(notice.runId),
      });
    }
  }
  const appendStreamSegment = (
    segment: Pick<ChatStreamSegment, "ts" | "runId" | "afterUserSendId">,
    key: string,
    text: string,
    thinking?: string,
    beforeKey?: string,
  ) => {
    const bounds = resolveProjectionBounds(segment.runId, segment.afterUserSendId);
    projections.push({
      item: {
        kind: "stream",
        key,
        text,
        ...(thinking ? { thinking } : {}),
        startedAt: segment.ts,
        isStreaming: false,
        ...optionalRunIdentity(segment.runId),
        ...optionalBoundaryIdentity(segment.runId),
      },
      bounds: beforeKey ? { ...bounds, beforeKey } : bounds,
    });
  };
  let previousAccumulatedStreamText: string | null = null;
  const maxLen = Math.max(indexedSegments.length, toolItems.length);
  for (let i = 0; i < maxLen; i++) {
    const segment = indexedSegments[i];
    if (segment) {
      const text = sanitizeStreamText(segment.text);
      const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
      previousAccumulatedStreamText = advanceAccumulatedStreamText(
        previousAccumulatedStreamText,
        text,
      );
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
    if (
      tool &&
      (props.showToolCalls ||
        hasHandoffToolCall(tool.projection.item.message) ||
        permissionInMessage(tool.projection.item.message))
    ) {
      tool.projection.bounds = resolveProjectionBounds(
        tool.runId,
        normalizeOptionalString(tool.projection.item.message.openclawToolStreamAfterSendId),
      );
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

  const visibleText = trimAccumulatedStreamPrefix(
    sanitizeStreamText(props.stream ?? ""),
    accumulatedStreamText(segments, sanitizeStreamText),
  );
  if (props.reasoning) {
    const { runId } = props.reasoning;
    for (const reasoning of props.reasoning.items) {
      if (
        reasoning === activeReasoning ||
        !reasoning.text ||
        (props.showReasoning && reasoning.receipt?.persisted)
      ) {
        continue;
      }
      const receipt = reasoning.receipt;
      // Provider timestamps may precede the first token. The receipt keeps
      // a stream-mode preview before its exact durable tool/answer row.
      const persisted = receipt?.persisted
        ? historyItems.find(({ message }) => {
            const identity = readChatThreadMessageIdentity(message);
            return (
              identity?.role === "assistant" &&
              !identity.isImported &&
              identity.id === receipt.messageId &&
              identity.runId === receipt.runId
            );
          })
        : undefined;
      appendStreamSegment(
        { runId, ts: reasoning.startedAt },
        `reasoning:${runId}:${reasoning.itemId}`,
        "",
        reasoning.text,
        persisted?.key,
      );
    }
  }

  // Unowned projections keep their user-turn floor despite clock skew;
  // identified live tools stay in the canonical invocation's interval.
  applyPersistedToolInvocationBounds(
    items,
    toolItems.map((tool) => tool.projection),
  );
  for (const tool of toolItems) {
    for (const item of pluginInlineViewItems(tool.projection.item, inlineInvocations)) {
      hideSearchMiss(item);
      projections.push({
        ...tool.projection,
        bounds:
          tool.projection.bounds ??
          resolveProjectionBounds(
            tool.runId,
            normalizeOptionalString(tool.projection.item.message.openclawToolStreamAfterSendId),
          ),
        item,
      });
    }
  }
  insertChatItemsByTimestamp(items, projections);

  // The active claw is telemetry, not a placeholder: it stays through visible
  // assistant text and tool cards until the run settles. The initial-load
  // skeleton still owns an otherwise empty thread, but not an active stream.
  const initialHistoryLoad = props.stream === null && props.loading === true && items.length === 0;
  // A non-null empty stream is the acknowledgement bridge before runWorking
  // catches up.
  const hasEmptyLiveStream = props.stream !== null && props.stream.trim().length === 0;
  const showWorkingIndicator =
    !props.runFinalizing &&
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
  const activeTurnBounds = boundToPendingInputs(
    (currentRunId ? createRunTurnLookup(executionItems())(currentRunId) : null) ??
      (activeInputKey ? { afterKey: activeInputKey } : null),
  );
  const appendActiveRunItem = (
    item: Extract<ChatItem, { kind: "stream" | "reading-indicator" }>,
  ) => {
    // Queued custody is a ceiling for the whole live response, not just its text.
    // Moving its working indicator past that ceiling splits and remeasures the run.
    if (activeTurnBounds) {
      const { maximum } = insertionIndexesForBounds(items, activeTurnBounds);
      items.splice(maximum, 0, item);
    } else {
      items.push(item);
    }
  };
  if (
    activeReasoning ||
    (visibleText.length > 0 && !stripHeartbeatTokenForDisplay(visibleText).shouldSkip)
  ) {
    const liveProgress = resolveProgress();
    const liveRunId = props.runId ?? props.reasoning?.runId ?? liveProgress.runId;
    // Unsaved answer text follows accepted steers at the run's live tail.
    appendActiveRunItem({
      kind: "stream",
      key: liveProgress.key,
      text: visibleText,
      thinking: activeReasoning?.text,
      startedAt: timestampAfterVisibleItems(
        items,
        props.streamStartedAt ?? activeReasoning?.startedAt ?? Date.now(),
      ),
      isStreaming: true,
      ...optionalRunIdentity(liveRunId),
      ...optionalBoundaryIdentity(liveRunId),
    });
  }
  if (showWorkingIndicator) {
    const workingProgress = resolveProgress();
    const workingRunId = props.runId ?? workingProgress.runId;
    appendActiveRunItem({
      kind: "reading-indicator",
      key: workingProgress.key,
      startedAt: workingProgress.startedAt,
      ...optionalRunIdentity(workingRunId),
      ...optionalBoundaryIdentity(workingRunId),
    });
  } else if (props.subagentWait && !initialHistoryLoad) {
    // The handoff ended the parent's run, not its work. Carrying that run's
    // identity keeps the claw in the same frame instead of opening another row.
    appendActiveRunItem({
      kind: "reading-indicator",
      key: `waiting-subagents:${props.sessionKey}`,
      startedAt: props.subagentWait.startedAt,
      waitingOn: "subagents",
      runId: props.subagentWait.runId,
    });
  }
  // Place output against the complete transcript before search hides any rows.
  // Pending/local inputs contribute people and turn boundaries just like history;
  // queued future inputs must remain after the live output they do not own.
  const hidden =
    hiddenHistoryKeys.size > 0 || hiddenKeys.size > 0
      ? new Set([...hiddenHistoryKeys, ...hiddenKeys])
      : undefined;
  const projectYields = (source: ChatItem[], complete?: ChatItem[]) =>
    projectSessionsYieldItems(source, props.showToolCalls, complete);
  // Keep real user boundaries even when search hides their rows.
  items = projectRunFailureStreaks(items);
  const complete = hidden ? projectYields(coalesceToolActivityMessages(items)) : undefined;
  return groupMessages(
    projectYields(coalesceToolActivityMessages(items, hidden), complete),
    { items: complete, people: props.replyPeople, localPerson: props.replyLocalPerson },
    props.showReasoning ? props.reasoning : undefined,
    props.showReasoning,
  );
}
