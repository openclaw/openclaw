import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";

export type ChatOutboxHostProjection = {
  byScope: Map<string, { scope: StoredChatOutboxScope; queue: ChatQueueItem[] }>;
  durableSeen: Set<string>;
};

export function reconcileChatOutboxProjection(
  state: ChatOutboxHostProjection,
  durableIds: ReadonlySet<string>,
  observeDurable: (id: string) => void,
): void {
  durableIds.forEach((id) => {
    state.durableSeen.add(id);
    observeDurable(id);
  });
  for (const local of state.byScope.values()) {
    local.queue = local.queue.filter(
      (item) => durableIds.has(item.id) || isActiveLocal(state, item),
    );
  }
}

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

export function isActiveLocal(
  state: { durableSeen: ReadonlySet<string> },
  item: ChatQueueItem,
): boolean {
  return Boolean(
    item.pendingRunId || item.sendState === "waiting-model" || !state.durableSeen.has(item.id),
  );
}

export function hasActiveChatOutboxProjection(state: ChatOutboxHostProjection): boolean {
  return [...state.byScope.values()].some(({ queue }) =>
    queue.some((item) => isActiveLocal(state, item)),
  );
}
