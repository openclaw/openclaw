import { chatQueueOrderKey } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadMatchesOwner,
  outboxStorageScope,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { applyStoredChatOutboxScope, type ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import type { ChatOutboxReloadBinding } from "./chat-outbox-reload-recovery.ts";

export type ChatOutboxHost = ChatComposerScope & {
  chatQueue: ChatQueueItem[];
  sessionKey: string;
  chatQueuedEdit?: { id: string } | null;
  outboxRecovery?: ChatOutboxReloadBinding;
};

export type ChatOutboxLiveProjection<Host> = {
  item: ChatQueueItem;
  owner: Host;
  expectedDurableVersion?: ChatQueueItem;
  submissionIsCurrent?: () => boolean;
};

export type ChatOutboxHostProjection = {
  byScope: Map<string, { scope: StoredChatOutboxScope; queue: ChatQueueItem[] }>;
  durableSeen: Set<string>;
};

export function positionChatOutboxItem(
  host: ChatComposerScope,
  scope: StoredChatOutboxScope,
  item: ChatQueueItem,
  retained: readonly ChatQueueItem[],
): ChatQueueItem {
  const existing = retained.find((entry) => entry.id === item.id);
  const tail = Math.max(...retained.map(chatQueueOrderKey));
  // Position belongs to admission, not clocks, storage timing, or state updates.
  const orderKey = existing
    ? existing.orderKey
    : (item.orderKey ?? (item.createdAt <= tail ? tail + 1 : undefined));
  const positioned = applyStoredChatOutboxScope(
    { ...item, storageScope: item.storageScope ?? outboxStorageScope(host) },
    scope,
  );
  if (outboxPayloadMatchesOwner(host, positioned)) {
    if (orderKey === undefined) {
      delete positioned.orderKey;
    } else {
      positioned.orderKey = orderKey;
    }
  }
  return positioned;
}

export function locateLocalOutboxItem(state: ChatOutboxHostProjection, id: string) {
  for (const { scope, queue } of state.byScope.values()) {
    const index = queue.findIndex((item) => item.id === id);
    if (index >= 0) {
      return { scope, queue, index };
    }
  }
  return undefined;
}

export function hasWaitingModelProjection(
  projections: Iterable<ChatOutboxHostProjection>,
  key: string,
  id: string,
): boolean {
  return [...projections].some((state) =>
    state.byScope
      .get(key)
      ?.queue.some((item) => item.id === id && item.sendState === "waiting-model"),
  );
}

export function retainedOutboxAttachmentIds<Host extends { chatQueue: ChatQueueItem[] }>(
  hosts: ReadonlyMap<Host, ChatOutboxHostProjection>,
  live: ReadonlyMap<string, ReadonlyMap<string, { item: ChatQueueItem }>>,
  volatile: ReadonlyMap<string, { item: ChatQueueItem }>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  const include = (item: ChatQueueItem) => {
    for (const attachment of item.attachments ?? []) {
      ids.add(attachment.id);
    }
  };
  for (const [host, state] of hosts) {
    host.chatQueue.forEach(include);
    for (const { queue } of state.byScope.values()) {
      queue.forEach(include);
    }
  }
  for (const entries of live.values()) {
    for (const { item } of entries.values()) {
      include(item);
    }
  }
  for (const { item } of volatile.values()) {
    include(item);
  }
  return ids;
}

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
