import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNodePermissionRequest } from "../../../../packages/gateway-protocol/src/node-permissions.js";
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

function isConfirmedPrPreparationHandoff(card: ToolCard): boolean {
  if (
    card.name !== "github_publish" ||
    asRecord(card.args)?.action !== "prepare_pr" ||
    card.completed !== true ||
    card.isError === true
  ) {
    return false;
  }
  const receipt = asRecord(card.details) ?? safeParseJsonRecord(card.outputText ?? "");
  return receipt?.status === "started" && receipt.async === true && receipt.yielded === true;
}

/** Keep handoff-capable calls and results until the projection can pair them. */
export function hasHandoffToolCall(message: unknown): boolean {
  return extractToolCardsCached(message).some(
    (card) => card.name === "sessions_yield" || card.name === "github_publish",
  );
}

/**
 * A sessions_yield acknowledgment is the agent speaking, so the projection adds
 * it as assistant text where the run handed off. These display-only facts let
 * that message mark when the run resumed.
 */
export type HandoffDisplay = { yieldedAt: number; resumedAt?: number };

export function readHandoffDisplay(message: unknown): HandoffDisplay | undefined {
  const handoff = asRecord(asRecord(message)?.openclawHandoff);
  return typeof handoff?.yieldedAt === "number"
    ? {
        yieldedAt: handoff.yieldedAt,
        ...(typeof handoff.resumedAt === "number" ? { resumedAt: handoff.resumedAt } : {}),
      }
    : undefined;
}

// Rows memoize on message identity; reuse the spoken copy while its facts hold.
const spokenAcknowledgments = new WeakMap<
  ToolCard,
  { text: string; handoff: HandoffDisplay; message: Record<string, unknown> }
>();

function spokenAcknowledgment(
  card: ToolCard,
  text: string,
  handoff: HandoffDisplay,
  runId: string | undefined,
) {
  const cached = spokenAcknowledgments.get(card);
  if (
    cached?.text === text &&
    cached.handoff.yieldedAt === handoff.yieldedAt &&
    cached.handoff.resumedAt === handoff.resumedAt
  ) {
    return cached.message;
  }
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: handoff.yieldedAt,
    ...(runId ? { runId } : {}),
    openclawHandoff: handoff,
  };
  spokenAcknowledgments.set(card, { text, handoff, message });
  return message;
}

/** The latest confirmed handoff that nothing has resumed yet. */
export type PendingSessionsYield = {
  timestamp: number | null;
  runId?: string;
};

type WorkingStatusItem = Extract<ChatItem, { kind: "reading-indicator" }>;

function isTurnStatus(item: ChatItem): item is WorkingStatusItem {
  return item.kind === "reading-indicator";
}

function scanSessionsYieldItems(
  items: ChatItem[],
  showToolCalls: boolean,
): { items: ChatItem[]; pending: PendingSessionsYield | null } {
  const projected: ChatItem[][] = [];
  let pending: PendingSessionsYield | null = null;
  let laterActivity = false;
  // When the closest later activity began: the moment a handoff resumed.
  let laterActivityAt: number | undefined;
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
    // PR preparation also yields, but its public tool details and non-subagent
    // lifecycle must not enter the private sessions_yield projection below.
    const handoff = lastYield ?? cards.findLast(isConfirmedPrPreparationHandoff);
    if (handoff) {
      // The invisible boundary keeps handed-off rows in place and separates
      // their run from a continuation without declaring an interruption.
      boundary.push({
        kind: "notice",
        key: `yield:${item.key}:${handoff.id}`,
        handoffBoundary: true,
        text: "",
        timestamp: (message && rawMessageTimestamp(message)) ?? 0,
      });
    }
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
        (insideWorkingTurn &&
          working !== undefined &&
          !working.item.waitingOn &&
          !working.item.runId);
      const handoffRunId = lastYield.runId ?? transcriptRunId(message);
      if (
        insideWorkingTurn &&
        handoffRunId &&
        (handoffRunId !== working?.item.runId || working?.item.waitingOn === "subagents") &&
        !handoffRunIds.includes(handoffRunId)
      ) {
        handoffRunIds.unshift(handoffRunId);
      }
      const facts = asRecord(lastYield.details) ?? safeParseJsonRecord(lastYield.outputText ?? "");
      const acknowledgment =
        typeof facts?.acknowledgment === "string" ? facts.acknowledgment.trim() : "";
      if (acknowledgment) {
        // The confirmed result echoes only the public acknowledgment, never the
        // private continuation context, and it stays after the run resumes.
        const resumedAt = resumed
          ? (laterActivityAt ?? (insideWorkingTurn ? working?.item.startedAt : undefined))
          : undefined;
        // Before the boundary, so it closes the run that handed off.
        boundary.unshift({
          kind: "message",
          key: `yield-ack:${item.key}:${lastYield.id}`,
          message: spokenAcknowledgment(
            lastYield,
            acknowledgment,
            {
              yieldedAt: timestamp ?? 0,
              ...(resumedAt !== undefined ? { resumedAt } : {}),
            },
            handoffRunId,
          ),
        });
      }
      if (!resumed) {
        pending = {
          timestamp: timestamp !== null && timestamp > 0 ? timestamp : null,
          ...(lastYield.runId ? { runId: lastYield.runId } : {}),
        };
        // Without words of its own, a message wait is a runtime status.
        if (!acknowledgment && asRecord(lastYield.args)?.waitFor === "message") {
          boundary.push({
            kind: "notice",
            key: `yield-status:${item.key}:${lastYield.id}`,
            text: t("chat.waitingForMessage"),
            timestamp: timestamp ?? 0,
          });
        }
      }
      laterActivity = true;
    }
    let remaining: ChatItem[] = [item];
    // Public handoff details follow the display preference after recognition.
    // Private continuation filtering below still uses only sessions_yield IDs.
    const hiddenGithubCards = showToolCalls
      ? []
      : cards.filter(
          (card) =>
            card.name === "github_publish" &&
            !readNodePermissionRequest(asRecord(card.details)?.permissionMissing),
        );
    const filterTools = yieldCards.length > 0 || hiddenGithubCards.length > 0;
    if (
      message &&
      filterTools &&
      !showToolCalls &&
      isStandaloneToolMessageForDisplay(message) &&
      (yieldCards.length > 0 || hiddenGithubCards.length === cards.length)
    ) {
      remaining = [];
    } else if (message && filterTools && Array.isArray(message.content)) {
      const yieldIds = new Set(yieldCards.map((card) => card.callId));
      const ids = new Set(yields.map((card) => card.callId));
      const hiddenGithubIds = new Set(hiddenGithubCards.map((card) => card.callId));
      const content = message.content.filter((block: unknown) => {
        const raw = asRecord(block);
        if (!raw || (!isToolCallContentType(raw.type) && !isToolResultContentType(raw.type))) {
          return true;
        }
        const id = resolveToolBlockId(raw, message);
        // A retained mixed row can also own an actionable permission request.
        // Hide only GitHub's cards; its siblings keep their original projection.
        if (!showToolCalls) {
          return (
            yieldCards.length === 0 &&
            (id ? !hiddenGithubIds.has(id) : raw.name !== "github_publish")
          );
        }
        // Live inputs can precede the sanitized history row. Yield context is never a tool detail.
        if (
          isToolCallContentType(raw.type) &&
          (id ? yieldIds.has(id) : raw.name === "sessions_yield")
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
                activity: readPreparedActivity(message).filter((activity) =>
                  showToolCalls
                    ? !yieldIds.has(activity.toolCallId ?? activity.itemId)
                    : yieldCards.length === 0 &&
                      !hiddenGithubIds.has(activity.toolCallId ?? activity.itemId),
                ),
              },
            },
          ]
        : [];
    }
    const slot = [...remaining, ...boundary];
    projected.push(slot);
    if (isTurnStatus(item)) {
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
    if (
      chatItemStartsUserTurn(item) ||
      item.kind === "stream" ||
      (message !== null &&
        normalizeRoleForGrouping(resolveMessageRole(message)) === "assistant" &&
        hasRenderableNormalizedMessage(message))
    ) {
      laterActivity = true;
      // A message you send after a handoff starts its own block; it is not a resume.
      laterActivityAt = chatItemStartsUserTurn(item)
        ? undefined
        : ((message
            ? rawMessageTimestamp(message)
            : item.kind === "stream"
              ? item.startedAt
              : null) ?? laterActivityAt);
    }
  }
  // Waiting on or resuming a handoff continues the same answer: its status counts
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
      request: {
        askedAt: status.askedAt,
        // Usage consumers add the status run itself, including while it waits.
        runIds: handoffRunIds.filter((runId) => runId !== status.item.runId),
      },
    };
  }
  return { items: projected.toReversed().flat(), pending };
}

/**
 * Keeps private yield calls out of tool details and separates a resumed run from the
 * run that handed off. A public acknowledgment becomes assistant text that stays
 * after the run resumes; a message wait without one keeps a runtime status notice,
 * and child waits use the working indicator.
 *
 * `complete` is this projection of the same transcript before search hid any
 * rows. A resumed run's request and handoffs are facts of the whole transcript,
 * so working and waiting statuses are taken from there, not from the matching rows.
 */
export function projectSessionsYieldItems(
  items: ChatItem[],
  showToolCalls = true,
  complete?: readonly ChatItem[],
): ChatItem[] {
  const projected = scanSessionsYieldItems(items, showToolCalls).items;
  const status = complete?.find(isTurnStatus);
  const completeKeys = complete && new Set(complete.map((item) => item.key));
  const visible = completeKeys
    ? projected.filter(
        (item) => !item.key.startsWith("yield-status:") || completeKeys.has(item.key),
      )
    : projected;
  return status
    ? visible.map((item) => (isTurnStatus(item) && item.key === status.key ? status : item))
    : visible;
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
