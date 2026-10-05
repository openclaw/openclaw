import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ToolCard } from "../../lib/chat/chat-types.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeRoleForGrouping,
  resolveMessageRole,
} from "../../lib/chat/message-normalizer.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import {
  buildMessageItems,
  hasRenderableNormalizedMessage,
  rawMessageTimestamp,
  resolveToolBlockId,
} from "./chat-thread-items.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

function isConfirmedYield(card: ToolCard): boolean {
  return (
    card.name === "sessions_yield" &&
    Object.hasOwn(card, "args") &&
    card.completed === true &&
    card.isError !== true &&
    (asRecord(card.details)?.status === "yielded" ||
      safeParseJsonRecord(card.outputText ?? "")?.status === "yielded")
  );
}

/** Yield is a transcript boundary, independent of tool disclosure preferences. */
export function hasSessionsYieldCall(message: unknown): boolean {
  return extractToolCardsCached(message).some((card) => card.name === "sessions_yield");
}

export function projectSessionsYieldItems(
  items: ChatItem[],
  activeRun?: { runId?: string | null; startedAt?: number | null },
  showToolCalls = true,
): ChatItem[] {
  const projected: ChatItem[][] = [];
  let laterActivity = false;
  const laterRuns = new Set<string>();
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const message = item.kind === "message" ? asRecord(item.message) : null;
    const cards = message ? extractToolCardsCached(message) : [];
    const yieldCards = cards.filter((card) => card.name === "sessions_yield");
    const yields = yieldCards.filter(isConfirmedYield);
    const markers: ChatItem[] = [];
    const timestamp = message ? rawMessageTimestamp(message) : null;
    for (let yieldIndex = yields.length - 1; yieldIndex >= 0; yieldIndex--) {
      const card = yields[yieldIndex]!;
      const resumed =
        laterActivity ||
        [...laterRuns].some((runId) => card.runId !== undefined && runId !== card.runId) ||
        (activeRun !== undefined &&
          ((card.runId !== undefined &&
            activeRun.runId != null &&
            activeRun.runId !== card.runId) ||
            (timestamp !== null &&
              activeRun.startedAt != null &&
              activeRun.startedAt > timestamp)));
      markers.unshift({
        kind: "notice",
        key: `yield:${item.key}:${card.id}`,
        sessionsYield: resumed ? "resumed" : "waiting",
        label: t(resumed ? "chat.yieldResumed" : "chat.yieldWaiting"),
        text: "",
        timestamp: timestamp ?? 0,
      });
      laterActivity = true;
    }
    let remaining: ChatItem[] = [item];
    if (
      message &&
      yieldCards.length > 0 &&
      !showToolCalls &&
      isStandaloneToolMessageForDisplay(message)
    ) {
      remaining = [];
    } else if (message && yieldCards.length > 0 && Array.isArray(message.content)) {
      const yieldIds = new Set(yieldCards.map((card) => card.callId));
      const ids = new Set(yields.map((card) => card.callId));
      const content = message.content.filter((block: unknown) => {
        const raw = asRecord(block);
        if (!raw || (!isToolCallContentType(raw.type) && !isToolResultContentType(raw.type))) {
          return true;
        }
        const id = resolveToolBlockId(raw, message);
        // Live inputs can precede the sanitized history row. Yield context is never a tool detail.
        if (
          !showToolCalls ||
          (isToolCallContentType(raw.type) &&
            (id ? yieldIds.has(id) : raw.name === "sessions_yield"))
        ) {
          return false;
        }
        return id ? !ids.has(id) : !(yields.length > 0 && raw.name === "sessions_yield");
      });
      remaining = content.length
        ? [
            {
              ...item,
              kind: "message",
              message: {
                ...message,
                content,
                activity: readPreparedActivity(message).filter(
                  (activity) =>
                    showToolCalls && !yieldIds.has(activity.toolCallId ?? activity.itemId),
                ),
              },
            },
          ]
        : [];
    }
    projected.push([...remaining, ...markers]);
    const runId = message
      ? transcriptRunId(message)
      : item.kind === "stream" || item.kind === "reading-indicator"
        ? item.runId
        : undefined;
    if (runId) {
      laterRuns.add(runId);
    }
    laterActivity ||=
      chatItemStartsUserTurn(item) ||
      item.kind === "stream" ||
      (message !== null &&
        normalizeRoleForGrouping(resolveMessageRole(message)) === "assistant" &&
        hasRenderableNormalizedMessage(message));
  }
  return projected.toReversed().flat();
}

const yieldTimestampByHistory = new WeakMap<readonly unknown[], number | null>();

/** Reuse the tool pairing owner for separate results and bundled nested calls. */
export function latestSessionsYieldTimestamp(messages: readonly unknown[]): number | null {
  if (yieldTimestampByHistory.has(messages)) {
    return yieldTimestampByHistory.get(messages) ?? null;
  }
  const items = projectSessionsYieldItems(
    coalesceToolActivityMessages(buildMessageItems(composeTranscriptDisplay([...messages]))),
  );
  const marker = items.findLast(
    (item) => item.kind === "notice" && item.sessionsYield === "waiting",
  );
  const timestamp = marker?.kind === "notice" && marker.timestamp > 0 ? marker.timestamp : null;
  yieldTimestampByHistory.set(messages, timestamp);
  return timestamp;
}
