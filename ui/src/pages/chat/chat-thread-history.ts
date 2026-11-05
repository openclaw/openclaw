import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNodePermissionRequest } from "../../../../packages/gateway-protocol/src/node-permissions.js";
import { readModelFallbackNotice } from "../../../../src/shared/model-fallback-notice.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  canvasPreviewsMatch,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import { pluginInlineViewItems } from "../../lib/chat/plugin-inline-views.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import {
  buildCompactionDividerItem,
  buildResetDividerItem,
  isContextCompactionMessage,
  matchesCompactionOperation,
} from "./chat-progress.ts";
import { hasHandoffToolCall } from "./chat-sessions-yield.ts";
import {
  createSubmittedModelNoticeProjector,
  projectChatSystemNotice,
} from "./chat-system-notice.ts";
import type { BuildChatItemsProps } from "./chat-thread-build.ts";
import { canvasAssistantItemKey, collectCanvasTurns } from "./chat-thread-canvas.ts";
import { displayChatHistory, type ChatItemsFacts } from "./chat-thread-facts.ts";
import {
  appendCanvasBlockToAssistantMessage,
  buildMessageItems,
  canvasPreviewBaseIdentity,
  createCanvasAssistantMessage,
  createChatSearchMatcher,
  extractChatMessagePreview,
  hasRenderableNormalizedMessage,
  rawMessageTimestamp,
  transcriptPositionTimestamp,
} from "./chat-thread-items.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";

export function permissionInMessage(message: unknown): boolean {
  return extractToolCardsCached(message).some((card) =>
    readNodePermissionRequest(asRecord(card.details)?.permissionMissing),
  );
}

export function prepareChatHistory(
  props: BuildChatItemsProps,
  activeCommentaryRunId?: string,
  probe?: unknown,
) {
  const facts: ChatItemsFacts = { firsts: new Map(), indexedDividers: [], probe };
  const items: ChatItem[] = [];
  const inlineInvocations = new Set<string>();
  const history = displayChatHistory(props, activeCommentaryRunId);
  facts.history = history;
  const searchFiltering = props.searchOpen === true && Boolean(props.searchQuery?.trim());
  const matchSource = createChatSearchMatcher(
    searchFiltering ? (props.searchQuery ?? "") : "",
    props.messageRecovery,
  );
  // Canvas lookahead and row filtering share one result per source in this build.
  // Derived inline/canvas messages have their own identity and search text.
  const searchMatches = searchFiltering ? new Map<unknown, boolean>() : undefined;
  const matchesSearch = (message: unknown) => {
    if (!searchMatches) {
      return true;
    }
    let matches = searchMatches.get(message);
    if (matches === undefined) {
      matches = matchSource(message);
      searchMatches.set(message, matches);
    }
    return matches;
  };
  const hiddenHistoryKeys = new Set<string>();
  const hideSearchMiss = (item: Extract<ChatItem, { kind: "message" }>) => {
    if (!matchesSearch(item.message)) {
      hiddenHistoryKeys.add(item.key);
    }
  };
  const canvasIdentities = new Set<string>();
  const normalizedHistory = history.map(safeNormalizeMessage);
  const historyItems = buildMessageItems(history);
  const canvasTurns = collectCanvasTurns(historyItems, normalizedHistory, matchesSearch);
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
    if (msg === facts.probe) {
      facts.modelBefore = projectSubmittedModel.state();
    }
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
      if (typeof marker?.id !== "string") {
        facts.indexedDividers.push(msg);
      }
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
      if (typeof marker.id !== "string") {
        facts.indexedDividers.push(msg);
      }
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
      facts.firsts.set(inline.key, msg);
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
        if (!duplicatePersistedCanvas) {
          facts.firsts.set(`canvas:${identity}`, msg);
        }
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
  return {
    items,
    history,
    historyItems,
    inlineInvocations,
    hiddenHistoryKeys,
    canvasIdentities,
    hasPersistedCompaction,
    facts,
  };
}

/** One persisted projection, owned by the existing pane/session/projection cache. */
export type ChatHistoryCache = {
  current?: { inputs: unknown[]; prepared: ReturnType<typeof prepareChatHistory> };
};
