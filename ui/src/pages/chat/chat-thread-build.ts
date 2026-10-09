import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
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
import {
  hasSessionsYieldCall,
  pendingSessionsYield,
  projectSessionsYieldItems,
} from "./chat-sessions-yield.ts";
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
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
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

function canvasAssistantItemKey(
  message: unknown,
  source: Parameters<typeof canvasPreviewBaseIdentity>[1],
  fallback: string,
): string {
  const identity = canvasPreviewBaseIdentity(message, source);
  return identity ? `canvas:${identity}` : `${fallback}:canvas`;
}

/** Move selected rows after their run output without changing saved transcript order. */
function orderSteersAfterRunOutput<T>(
  items: T[],
  steerTarget: (item: T) => string | null,
  outputRuns: (item: T) => Iterable<string>,
): T[] {
  const lastOutput = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    for (const runId of outputRuns(item)) {
      lastOutput.set(runId, index);
    }
  }
  const deferred = new Map<number, T[]>();
  return items.flatMap((item, index) => {
    const target = steerTarget(item);
    const after = target ? lastOutput.get(target) : undefined;
    if (after !== undefined && after > index) {
      const steers = deferred.get(after) ?? [];
      steers.push(item);
      deferred.set(after, steers);
      return [];
    }
    return [item, ...(deferred.get(index) ?? [])];
  });
}

export function buildChatItems(
  props: BuildChatItemsProps,
  inputOrder: ChatInputOrderState = { keys: [] },
): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const outputRuns = new Map<string, Set<string>>();
  const ownOutput = <T extends ChatItem>(item: T, sourceRunId: unknown): T => {
    const runId = normalizeOptionalString(sourceRunId);
    if (runId) {
      const runs = outputRuns.get(item.key) ?? new Set<string>();
      runs.add(runId);
      outputRuns.set(item.key, runs);
    }
    return item;
  };
  const tools = props.toolMessages.filter(
    (message): message is Record<string, unknown> => asRecord(message) !== null,
  );
  const toolItems = buildMessageItems(tools).map((item) => {
    const projection: ChatProjection<typeof item> = {
      item: ownOutput(item, transcriptRunId(item.message)),
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
  const history = orderSteersAfterRunOutput(
    composeTranscriptDisplay(
      props.messages.filter(
        (message) =>
          !isAssistantHeartbeatAckForDisplay(message) &&
          (props.persistCommentary !== false ||
            !isKeyedAssistantStreamFallbackMessage(message) ||
            (activeCommentaryRunId !== undefined &&
              transcriptRunId(message) === activeCommentaryRunId)),
      ),
    ),
    (message) =>
      readSessionMessageIdentity(message)?.role === "user"
        ? persistedSteerTargetRunId(message)
        : null,
    (message) => {
      const runId =
        readSessionMessageIdentity(message)?.role === "user" ? undefined : transcriptRunId(message);
      return runId ? [runId] : [];
    },
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
      items.push(
        ownOutput(
          {
            ...divider,
            compactionId: divider.key,
            ...(matchesLive && compactionKey ? { key: compactionKey } : {}),
          },
          transcriptRunId(msg) ?? (matchesLive ? compaction?.runId : undefined),
        ),
      );
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
        items.push(
          ownOutput(
            { kind: "notice", key: itemKey, text, timestamp: normalized.timestamp },
            transcriptRunId(msg),
          ),
        );
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
      ownOutput(matchingCanvas.item, transcriptRunId(msg));
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
      items.push(
        ownOutput(
          {
            kind: "message",
            key: canvasAssistantItemKey(msg, persistedCanvasSource, itemKey),
            message: createCanvasAssistantMessage(
              persistedCanvasSource,
              persistedCanvasSource.timestamp ?? transcriptPositionTimestamp(history, i),
            ),
          },
          transcriptRunId(msg),
        ),
      );
    }

    if (!props.showToolCalls && isToolResult && !hasSessionsYieldCall(msg)) {
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

    items.push(
      ...projectChatSystemNotice(item, normalized).map((projected) =>
        role === "user" ? projected : ownOutput(projected, transcriptRunId(msg)),
      ),
    );
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
  const resolveRunBounds = (lookup: typeof canvasRunBounds, runId: unknown) =>
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
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const canvasBounds = boundToPendingInputs(
      resolveRunBounds(canvasRunBounds, projection.item.message.runId),
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
      items[assistant.index] = ownOutput(
        {
          ...assistant.item,
          message: appendCanvasBlockToAssistantMessage(
            assistant.item.message,
            preview.preview,
            preview.text,
          ),
        },
        transcriptRunId(projection.item.message),
      );
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
    items.splice(
      insertionIndex,
      0,
      ownOutput(
        {
          kind: "message",
          key: canvasAssistantItemKey(projection.item.message, preview, projection.item.key),
          message: createCanvasAssistantMessage(preview, timestamp),
        },
        transcriptRunId(projection.item.message),
      ),
    );
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const projections: ChatProjection[] = [];
  if (compaction && compactionKey && !hasPersistedCompaction) {
    const timestamp = compaction.startedAt ?? compaction.completedAt ?? Date.now();
    projections.push({
      item: ownOutput(
        {
          ...buildCompactionDividerItem(
            {},
            timestamp,
            0,
            compaction.phase === "complete" ? "complete" : "active",
          ),
          key: compactionKey,
        },
        compaction.runId,
      ),
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
  const resolveProjectionBounds = (runId: unknown): TurnInsertionBounds | undefined =>
    boundToPendingInputs(resolveRunBounds(projectionRunBounds, runId));
  if (!searchFiltering) {
    if (props.archiveNotice) {
      projections.push({ item: props.archiveNotice });
    }
    for (const notice of props.guardianNotices ?? []) {
      projections.push({
        item: ownOutput(buildGuardianNoticeItem(notice), notice.runId),
        bounds: resolveProjectionBounds(notice.runId),
      });
    }
  }
  const appendStreamSegment = (segment: ChatStreamSegment, key: string, text: string) => {
    projections.push({
      item: ownOutput(
        {
          kind: "stream",
          key,
          text,
          startedAt: segment.ts,
          isStreaming: false,
          ...optionalRunIdentity(segment.runId),
          ...optionalBoundaryIdentity(segment.runId),
        },
        segment.runId,
      ),
      bounds: resolveProjectionBounds(segment.runId),
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
    if (tool && (props.showToolCalls || hasSessionsYieldCall(tool.projection.item.message))) {
      tool.projection.bounds = resolveProjectionBounds(tool.runId);
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
      item: ownOutput(questionItem, prompt.runId),
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
  const activeTurnBounds = boundToPendingInputs(
    (currentRunId ? createRunTurnLookup(executionItems())(currentRunId) : null) ??
      (activeInputKey ? { afterKey: activeInputKey } : null),
  );
  const appendActiveRunItem = (
    item: Extract<ChatItem, { kind: "stream" | "reading-indicator" }>,
  ) => {
    ownOutput(item, item.runId);
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
        key: liveProgress.key,
        text: visibleText,
        startedAt: timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now()),
        isStreaming: true,
        ...optionalRunIdentity(liveRunId),
        ...optionalBoundaryIdentity(liveRunId),
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
  items = orderSteersAfterRunOutput(
    items,
    (item) =>
      item.kind === "message" && readSessionMessageIdentity(item.message)?.role === "user"
        ? persistedSteerTargetRunId(item.message)
        : null,
    (item) => outputRuns.get(item.key) ?? [],
  );
  // Place output against the complete transcript before search hides any rows.
  // Pending/local inputs contribute people and turn boundaries just like history;
  // queued future inputs must remain after the live output they do not own.
  const hidden =
    hiddenHistoryKeys.size > 0 || hiddenKeys.size > 0
      ? new Set([...hiddenHistoryKeys, ...hiddenKeys])
      : undefined;
  const projectYields = (source: ChatItem[], complete?: ChatItem[]) =>
    projectSessionsYieldItems(source, props.showToolCalls, complete);
  const complete = hidden ? projectYields(coalesceToolActivityMessages(items)) : undefined;
  return groupMessages(projectYields(coalesceToolActivityMessages(items, hidden), complete), {
    items: complete,
    people: props.replyPeople,
    localPerson: props.replyLocalPerson,
  });
}
