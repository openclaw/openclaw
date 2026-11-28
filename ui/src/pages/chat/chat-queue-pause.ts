import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxOwnerKey } from "../../lib/chat/outbox-owner-registry.ts";
import {
  type StoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store-scope.ts";
import type { ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";

type Host = ChatComposerScope & { sessionKey: string; chatQueue?: readonly ChatQueueItem[] };

// Rows a user Stop parked, keyed like the shared outbox so every pane agrees. Only
// rows waiting at Stop park; later submissions and handed-off rows keep moving.
// In memory per tab: a reload or another tab resumes draining, visibly.
const parkedRows = new Map<string, ReadonlySet<string>>();
// Rows already handed to delivery keep their reconnect and reconciliation path.
const IN_FLIGHT = new Set<ChatQueueItem["sendState"]>([
  "submitting",
  "sending",
  "waiting-reconnect",
  "executing-command",
]);

function pauseKey(host: ChatComposerScope, scope: StoredChatOutboxScope): string {
  return `${outboxOwnerKey(host)}\u0000${storedChatOutboxScopeKey(scope)}`;
}

function paneScope(host: Host): StoredChatOutboxScope {
  return resolveUiConversationIdentity(host, host.sessionKey);
}

/** Parks the never-attempted rows waiting at Stop, or releases them for Resume. */
export function setChatQueuePaused(host: Host, paused: boolean, scope = paneScope(host)): void {
  const key = pauseKey(host, scope);
  const ids = paused
    ? (host.chatQueue ?? []).filter((item) => !item.sendAttempts && !IN_FLIGHT.has(item.sendState))
    : [];
  if (!ids.length && !parkedRows.has(key)) {
    return;
  }
  if (ids.length) {
    parkedRows.set(key, new Set(ids.map((item) => item.id)));
  } else {
    parkedRows.delete(key);
  }
  chatOutboxOwner(host).publish();
}

export function parkedChatQueueRows(
  host: Host,
  scope = paneScope(host),
): ReadonlySet<string> | undefined {
  return parkedRows.get(pauseKey(host, scope));
}

/** True while a parked row is still queued; removing or sending them all ends the pause. */
export function isChatQueuePaused(host: Host): boolean {
  const parked = parkedChatQueueRows(host);
  return Boolean(parked && host.chatQueue?.some((item) => parked.has(item.id)));
}
