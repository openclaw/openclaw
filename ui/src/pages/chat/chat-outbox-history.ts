import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";

type HistoryRead = {
  client: object;
  connectionEpoch: number | undefined;
  item: ChatQueueItem;
  cursor?: string;
};

export class ChatOutboxHistory {
  private readonly reads = new WeakMap<object, Map<string, HistoryRead>>();

  capture(
    host: object,
    scope: StoredChatOutboxScope,
    item: ChatQueueItem,
    client: object,
    connectionEpoch: number | undefined,
  ) {
    const key = storedChatOutboxScopeKey(scope);
    const reads = this.reads.get(host) ?? new Map<string, HistoryRead>();
    this.reads.set(host, reads);
    const previous = reads.get(key);
    const read: HistoryRead =
      previous?.client === client &&
      previous.connectionEpoch === connectionEpoch &&
      previous.item.sessionId === item.sessionId &&
      sameQueuedDeliveryVersion(previous.item, item)
        ? previous
        : { client, connectionEpoch, item, cursor: undefined };
    reads.set(key, read);
    return {
      cursor: read.cursor,
      accept: (cursor: string | undefined) => {
        if (this.reads.get(host)?.get(key) === read) {
          read.cursor = cursor;
        }
      },
    } as const;
  }

  forget(host: object): void {
    this.reads.delete(host);
  }

  reconcile(host: object, outboxes: readonly StoredChatOutbox[]): void {
    // One watermark per retained outbox; item removal retires its read position.
    const reads = this.reads.get(host);
    for (const [key, read] of reads ?? []) {
      if (
        !outboxes.some(
          (outbox) =>
            storedChatOutboxScopeKey(outbox) === key &&
            outbox.queue.some((item) => item.id === read.item.id),
        )
      ) {
        reads?.delete(key);
      }
    }
  }
}
