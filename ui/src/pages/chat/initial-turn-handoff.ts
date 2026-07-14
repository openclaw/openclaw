import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";

const INITIAL_TURN_HANDOFF_TTL_MS = 60_000;

type InitialTurnHandoff = {
  item: ChatQueueItem;
  sessionKey: string;
  timer: ReturnType<typeof globalThis.setTimeout>;
};

let pending: InitialTurnHandoff | null = null;

function clearPending(releaseAttachments: boolean): void {
  if (!pending) {
    return;
  }
  globalThis.clearTimeout(pending.timer);
  if (releaseAttachments) {
    releaseChatAttachmentPayloads(pending.item.attachments ?? []);
  }
  pending = null;
}

/** Hands one storage-rejected initial turn to the chat route that owns its created session. */
export function prepareInitialTurnHandoff(sessionKey: string, item: ChatQueueItem): void {
  clearPending(true);
  const timer = globalThis.setTimeout(() => clearPending(true), INITIAL_TURN_HANDOFF_TTL_MS);
  pending = { item, sessionKey, timer };
}

export function consumeInitialTurnHandoff(sessionKey: string): ChatQueueItem | null {
  if (!pending || !areUiSessionKeysEquivalent(pending.sessionKey, sessionKey)) {
    return null;
  }
  const item = pending.item;
  clearPending(false);
  return item;
}
