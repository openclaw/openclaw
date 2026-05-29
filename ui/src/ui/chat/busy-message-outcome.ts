import type { LastBusyMessageOutcome } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import type { ChatQueueItem } from "../ui-types.ts";

export type ChatQueueBusyOutcome = LastBusyMessageOutcome;

export type ChatQueueOutcomeBadge = {
  text: string;
  title: string;
  variant: "steered" | "followup" | "fallback" | "neutral";
};

export function resolveChatQueueOutcomeBadge(outcome: ChatQueueBusyOutcome): ChatQueueOutcomeBadge {
  switch (outcome.kind) {
    case "active_run_steer_accepted":
      return {
        text: "Steered",
        title: outcome.label,
        variant: "steered",
      };
    case "active_run_steer_rejected":
      return {
        text: "Steer fallback",
        title: outcome.reason ? `${outcome.label} (${outcome.reason})` : outcome.label,
        variant: "fallback",
      };
    case "followup_enqueued":
      return {
        text: "Queued follow-up",
        title: outcome.label,
        variant: "followup",
      };
    case "collect_enqueued":
      return {
        text: "Queued for collect",
        title: outcome.label,
        variant: "followup",
      };
    case "interrupt_started":
      return {
        text: "Interrupting",
        title: outcome.label,
        variant: "neutral",
      };
    case "dropped":
      return {
        text: "Dropped",
        title: outcome.label,
        variant: "fallback",
      };
    default:
      return {
        text: outcome.label,
        title: outcome.label,
        variant: "neutral",
      };
  }
}

export function resolveChatQueueItemOutcomeBadge(
  item: ChatQueueItem,
): ChatQueueOutcomeBadge | null {
  if (item.busyOutcome) {
    return resolveChatQueueOutcomeBadge(item.busyOutcome);
  }
  if (item.kind === "steered") {
    return {
      text: "Steered",
      title: "Steered into active run",
      variant: "steered",
    };
  }
  return null;
}

export function isChatQueueItemSteered(item: ChatQueueItem): boolean {
  if (item.busyOutcome) {
    return item.busyOutcome.kind === "active_run_steer_accepted";
  }
  return item.kind === "steered";
}

function shouldApplyBusyOutcomeToItem(item: ChatQueueItem, outcome: ChatQueueBusyOutcome): boolean {
  if (item.sendState === "sending" || item.sendState === "failed") {
    return false;
  }
  if (item.createdAt > outcome.recordedAtMs + 5_000) {
    return false;
  }
  if (item.busyOutcome && item.busyOutcome.recordedAtMs >= outcome.recordedAtMs) {
    return false;
  }
  return true;
}

function applyBusyOutcomeToQueue(
  queue: ChatQueueItem[],
  outcome: ChatQueueBusyOutcome,
): { changed: boolean; queue: ChatQueueItem[] } {
  let targetIndex = -1;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (shouldApplyBusyOutcomeToItem(queue[index], outcome)) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    return { changed: false, queue };
  }

  const next = [...queue];
  const item = next[targetIndex];
  const steeredAccepted = outcome.kind === "active_run_steer_accepted";
  next[targetIndex] = {
    ...item,
    busyOutcome: outcome,
    kind: steeredAccepted ? "steered" : item.kind === "steered" ? undefined : item.kind,
  };
  return { changed: true, queue: next };
}

function resolveSessionBusyOutcome(
  sessionsResult: SessionsListResult | null | undefined,
  sessionKey: string,
): ChatQueueBusyOutcome | undefined {
  return sessionsResult?.sessions.find((row) => row.key === sessionKey)?.lastBusyMessageOutcome;
}

export function applySessionBusyOutcomesToChatQueue(host: {
  sessionKey: string;
  chatQueue: ChatQueueItem[];
  chatQueueBySession?: Record<string, ChatQueueItem[]>;
  sessionsResult?: SessionsListResult | null;
}): boolean {
  let changed = false;

  const activeOutcome = resolveSessionBusyOutcome(host.sessionsResult, host.sessionKey);
  if (activeOutcome) {
    const next = applyBusyOutcomeToQueue(host.chatQueue, activeOutcome);
    if (next.changed) {
      host.chatQueue = next.queue;
      changed = true;
    }
  }

  const queueBySession = host.chatQueueBySession;
  if (!queueBySession) {
    return changed;
  }

  const nextBySession = { ...queueBySession };
  for (const [sessionKey, queue] of Object.entries(queueBySession)) {
    const outcome = resolveSessionBusyOutcome(host.sessionsResult, sessionKey);
    if (!outcome) {
      continue;
    }
    const next = applyBusyOutcomeToQueue(queue, outcome);
    if (next.changed) {
      nextBySession[sessionKey] = next.queue;
      changed = true;
    }
  }
  if (changed) {
    host.chatQueueBySession = nextBySession;
  }
  return changed;
}

export function sessionRowHasBusyOutcome(row: GatewaySessionRow | undefined): boolean {
  return row?.lastBusyMessageOutcome != null;
}
