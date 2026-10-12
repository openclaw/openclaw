import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
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

/** A handoff's private continuation is never a tool detail, whatever the disclosure preference. */
export function hasSessionsYieldCall(message: unknown): boolean {
  return extractToolCardsCached(message).some((card) => card.name === "sessions_yield");
}

/** The latest confirmed handoff that nothing has resumed yet. */
export type PendingSessionsYield = {
  timestamp: number | null;
  runId?: string;
};

type WorkingStatusItem = Extract<ChatItem, { kind: "reading-indicator" }>;

function isWorkingStatus(item: ChatItem): item is WorkingStatusItem {
  return item.kind === "reading-indicator" && !item.waitingOn;
}

function scanSessionsYieldItems(
  items: ChatItem[],
  showToolCalls: boolean,
): { items: ChatItem[]; pending: PendingSessionsYield | null } {
  const projected: ChatItem[][] = [];
  let pending: PendingSessionsYield | null = null;
  let laterActivity = false;
  const laterRuns = new Set<string>();
  // The working status and, while the scan is still inside its turn, the runs
  // and handoffs between it and the message that asked.
  let working: { slot: ChatItem[]; item: WorkingStatusItem; askedAt?: number } | undefined;
  let insideWorkingTurn = false;
  const turnRuns = new Set<string>();
  const handoffRunIds: string[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const message = item.kind === "message" ? asRecord(item.message) : null;
    const cards = message ? extractToolCardsCached(message) : [];
    const yieldCards = cards.filter((card) => card.name === "sessions_yield");
    const yields = yieldCards.filter(isConfirmedYield);
    const lastYield = yields.at(-1);
    const boundary: ChatItem[] = [];
    if (lastYield) {
      const timestamp = message ? rawMessageTimestamp(message) : null;
      // Later output, or output from another run, means the parent already
      // resumed. So does a working status whose run the pane cannot name yet:
      // after a confirmed handoff, only what continues it can be working.
      const resumed =
        laterActivity ||
        [...laterRuns].some(
          (runId) => lastYield.runId !== undefined && runId !== lastYield.runId,
        ) ||
        (insideWorkingTurn && working !== undefined && !working.item.runId);
      // Nothing is drawn here. The boundary keeps the handed-off turn's rows in
      // place, also between the wait ending and the resume, and keeps a resumed
      // run's rows from pooling or rolling up with the run that handed off.
      boundary.push({
        kind: "notice",
        key: `yield:${item.key}:${lastYield.id}`,
        handoffBoundary: true,
        text: "",
        timestamp: timestamp ?? 0,
      });
      if (resumed) {
        const handoffRunId = lastYield.runId ?? transcriptRunId(message);
        if (
          insideWorkingTurn &&
          handoffRunId &&
          handoffRunId !== working?.item.runId &&
          !handoffRunIds.includes(handoffRunId)
        ) {
          handoffRunIds.unshift(handoffRunId);
        }
      } else {
        pending = {
          timestamp: timestamp !== null && timestamp > 0 ? timestamp : null,
          ...(lastYield.runId ? { runId: lastYield.runId } : {}),
        };
      }
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
    const slot = [...remaining, ...boundary];
    projected.push(slot);
    if (isWorkingStatus(item)) {
      working = { slot, item };
      insideWorkingTurn = true;
    } else if (insideWorkingTurn && chatItemStartsUserTurn(item)) {
      const askedAt = message ? rawMessageTimestamp(message) : null;
      if (working && askedAt !== null && askedAt > 0) {
        working.askedAt = askedAt;
      }
      insideWorkingTurn = false;
    }
    const runId = message
      ? transcriptRunId(message)
      : item.kind === "stream" || item.kind === "reading-indicator"
        ? item.runId
        : undefined;
    if (runId) {
      laterRuns.add(runId);
      if (insideWorkingTurn) {
        turnRuns.add(runId);
      }
    }
    laterActivity ||=
      chatItemStartsUserTurn(item) ||
      item.kind === "stream" ||
      (message !== null &&
        normalizeRoleForGrouping(resolveMessageRole(message)) === "assistant" &&
        hasRenderableNormalizedMessage(message));
  }
  // A run that resumes a handoff continues the same answer: its status counts
  // from the request and names the runs before it. That needs the loaded turn
  // to be exactly that chain, from the message that asked. A turn that also
  // holds another run, or starts outside the window, keeps the run's own status
  // so its time and tokens never describe different sets of runs.
  const status = working;
  if (
    status?.askedAt !== undefined &&
    handoffRunIds.length > 0 &&
    [...turnRuns].every((runId) => runId === status.item.runId || handoffRunIds.includes(runId))
  ) {
    status.slot[status.slot.indexOf(status.item)] = {
      ...status.item,
      startedAt: Math.min(status.item.startedAt, status.askedAt),
      request: { askedAt: status.askedAt, runIds: handoffRunIds },
    };
  }
  return { items: projected.toReversed().flat(), pending };
}

/**
 * Keeps handoff calls out of tool details and separates a resumed run from the
 * run that handed off. The working indicator shows the wait itself.
 *
 * `complete` is this projection of the same transcript before search hid any
 * rows. A resumed run's request and handoffs are facts of the whole transcript,
 * so its working status is taken from there, not from the matching rows.
 */
export function projectSessionsYieldItems(
  items: ChatItem[],
  showToolCalls = true,
  complete?: readonly ChatItem[],
): ChatItem[] {
  const projected = scanSessionsYieldItems(items, showToolCalls).items;
  const status = complete?.find(isWorkingStatus);
  return status
    ? projected.map((item) => (isWorkingStatus(item) && item.key === status.key ? status : item))
    : projected;
}

const pendingYieldByHistory = new WeakMap<readonly unknown[], PendingSessionsYield | null>();

/** Reuse the tool pairing owner for separate results and bundled nested calls. */
export function pendingSessionsYield(messages: readonly unknown[]): PendingSessionsYield | null {
  if (pendingYieldByHistory.has(messages)) {
    return pendingYieldByHistory.get(messages) ?? null;
  }
  const { pending } = scanSessionsYieldItems(
    coalesceToolActivityMessages(buildMessageItems(composeTranscriptDisplay([...messages]))),
    true,
  );
  pendingYieldByHistory.set(messages, pending);
  return pending;
}
