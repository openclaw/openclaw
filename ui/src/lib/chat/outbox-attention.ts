import { readOfflineStorageScope } from "../../app/boot-record.ts";
import {
  chatOutboxAttentionOwners,
  outboxOwnerKey,
  storedChatOutboxItemNeedsReview,
} from "./outbox-owner-registry.ts";
import { listStoredChatOutboxes } from "./outbox-store-projection.ts";
import type { ChatComposerScope } from "./outbox-store.ts";

/** Read-only view of the existing tab/Gateway outbox; it does not claim a personal owner. */
export function listChatOutboxAttention(host: ChatComposerScope) {
  if (!readOfflineStorageScope(host)) {
    return [];
  }
  const outboxes = listStoredChatOutboxes(host);
  const owner = chatOutboxAttentionOwners.get(outboxOwnerKey(host));
  return outboxes.flatMap((outbox) =>
    outbox.queue
      .filter((item) =>
        owner ? owner.needsReview(outbox, item) : storedChatOutboxItemNeedsReview(item),
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
