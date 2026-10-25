import type { GatewayEventFrame } from "../../api/gateway.ts";
import {
  listStoredChatOutboxes,
  readStoredChatOutbox,
  type StoredChatOutbox,
} from "../../lib/chat/outbox-store-projection.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { readSessionChangedEvent } from "../../lib/sessions/session-row-reconcile.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import type { ChatHost } from "./chat-send-contract.ts";

export function readChatOutboxLane(
  host: ChatHost,
  scope: StoredChatOutboxScope,
): StoredChatOutbox | null {
  const stored = readStoredChatOutbox(host, scope);
  const queue = chatOutboxOwner(host).snapshot(host, scope, stored?.queue ?? []);
  return queue.length ? { ...scope, queue } : null;
}

export function collectChatOutboxes(host: ChatHost, event?: GatewayEventFrame): StoredChatOutbox[] {
  // Refresh credential ownership; callers own frame-coalesced rendering.
  chatOutboxOwner(host).syncHost(host, { notify: false });
  const eventScope = event ? readSessionChangedEvent(event.payload) : undefined;
  if (event && !eventScope) {
    return [];
  }
  const scopes = new Map(
    listStoredChatOutboxes(host).map((outbox) => [storedChatOutboxScopeKey(outbox), outbox]),
  );
  for (const item of chatOutboxOwner(host).allItems(host)) {
    const scope = resolveUiConversationIdentity(
      host,
      item.sessionKey ?? host.sessionKey,
      item.agentId,
    );
    const key = storedChatOutboxScopeKey(scope);
    if (!scopes.has(key)) {
      const outbox = readChatOutboxLane(host, scope);
      if (outbox) {
        scopes.set(key, outbox);
      }
    }
  }
  return [...scopes.values()].filter(
    (outbox) =>
      !eventScope ||
      (areUiSessionKeysEquivalent(outbox.sessionKey, eventScope.key) &&
        (!isUiGlobalSessionKey(outbox.sessionKey) ||
          (eventScope.agentId !== null &&
            outbox.agentId === normalizeAgentId(eventScope.agentId)))),
  );
}
