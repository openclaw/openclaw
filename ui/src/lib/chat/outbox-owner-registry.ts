import { notifyListeners } from "../../../../src/shared/listeners.js";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import type { StoredChatOutboxScope } from "./outbox-store-scope.ts";
import type { ChatComposerScope } from "./outbox-store.ts";

// Presentation can consult the existing owner without loading the chat send graph.
export const chatOutboxAttentionOwners = new Map<
  string,
  {
    attentionRevision: number;
    needsReview(scope: StoredChatOutboxScope, item: ChatQueueItem): boolean;
  }
>();
const storageIds = new WeakMap<Storage, number>();
let nextStorageId = 0;
const attentionListeners = new Set<(ownerKey: string) => void>();

export function outboxOwnerKey(host: ChatComposerScope): string {
  const storage = getSafeSessionStorage();
  if (storage && !storageIds.has(storage)) {
    storageIds.set(storage, ++nextStorageId);
  }
  return `${storage ? storageIds.get(storage) : 0}\u0000${host.settings?.gatewayUrl?.trim() || "default"}\u0000${readOfflineStorageScope(host) ?? ""}`;
}

export function storedChatOutboxItemNeedsReview(item: ChatQueueItem): boolean {
  return (
    !item.pendingRunId &&
    (item.sendState === "failed" || item.sendState === "unconfirmed" || item.sendState === "held")
  );
}

export function subscribeChatOutboxAttentionChanges(listener: (ownerKey: string) => void) {
  attentionListeners.add(listener);
  return () => {
    attentionListeners.delete(listener);
  };
}

export function notifyChatOutboxAttentionChanges(ownerKey: string): void {
  // Live overlays do not change storage; storage events would reenter the owner's publication.
  notifyListeners(attentionListeners, ownerKey, (error) =>
    console.error("[openclaw] chat outbox attention listener failed", error),
  );
}
