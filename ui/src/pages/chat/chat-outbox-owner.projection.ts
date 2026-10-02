import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { StoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";

export type ChatOutboxHostProjection = {
  byScope: Map<string, { scope: StoredChatOutboxScope; queue: ChatQueueItem[] }>;
  durableSeen: Set<string>;
  retryable: Set<string>;
};

/** Merge pane presentation only; the outbox owner retains custody and authority. */
export function projectChatOutboxItem(item: ChatQueueItem, local: ChatQueueItem): ChatQueueItem {
  const projected: ChatQueueItem = { ...item };
  if (local.attachments) {
    const presented = new Map(local.attachments.map((attachment) => [attachment.id, attachment]));
    projected.attachments = (item.attachments ?? local.attachments).map((attachment) =>
      Object.assign({}, attachment, presented.get(attachment.id)),
    );
  }
  for (const key of ["sendSubmittedAtMs", "sendRequestStartedAtMs"] as const) {
    if (typeof local[key] === "number") {
      projected[key] = local[key];
    }
  }
  return projected;
}

export function projectChatOutboxAttention(
  outboxes: readonly StoredChatOutbox[],
  owner?: { needsReview(scope: StoredChatOutboxScope, item: ChatQueueItem): boolean },
) {
  return outboxes.flatMap((outbox) =>
    outbox.queue
      .filter((item) =>
        owner
          ? owner.needsReview(outbox, item)
          : !item.pendingRunId &&
            (item.sendState === "failed" ||
              item.sendState === "unconfirmed" ||
              item.sendState === "held"),
      )
      .map((item) => ({
        id: item.id,
        sessionKey: outbox.sessionKey,
        agentId: outbox.agentId,
        unconfirmed: item.sendState === "unconfirmed" || item.sendState === "held",
        command: Boolean(item.localCommandName),
      })),
  );
}

export function isActiveLocal(
  state: { durableSeen: ReadonlySet<string>; retryable: ReadonlySet<string> },
  item: ChatQueueItem,
): boolean {
  return Boolean(
    item.pendingRunId ||
    item.sendState === "waiting-model" ||
    state.retryable.has(item.id) ||
    !state.durableSeen.has(item.id),
  );
}
