import { registerListener } from "../../../../src/shared/listeners.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxPayloadMatchesOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatHost } from "./chat-send-contract.ts";

const INITIAL_TURN_HANDOFF_TTL_MS = 60_000;

type InitialTurnHandoff = {
  item: ChatQueueItem;
  sessionKey: string;
  timer: ReturnType<typeof globalThis.setTimeout>;
  retryAfter?: Promise<boolean>;
};

let pending: InitialTurnHandoff | null = null;
const listeners = new Set<() => void>();

export function subscribeInitialTurnHandoff(listener: () => void): () => void {
  return registerListener(listeners, listener);
}

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

/** Transfer the created session's rejected turn and optional consent-gated retry to its pane. */
export function prepareInitialTurnHandoff(
  sessionKey: string,
  item: ChatQueueItem,
  retryAfter?: Promise<boolean>,
): void {
  clearPending(true);
  const timer = globalThis.setTimeout(() => clearPending(true), INITIAL_TURN_HANDOFF_TTL_MS);
  pending = { item, sessionKey, timer, retryAfter };
  for (const listener of listeners) {
    listener();
  }
}

export function takeInitialTurnHandoff(
  host: ChatHost,
  sessionKey: string,
): InitialTurnHandoff | null {
  if (
    !pending ||
    !areUiSessionKeysEquivalent(pending.sessionKey, sessionKey) ||
    !outboxPayloadMatchesOwner(host, pending.item)
  ) {
    return null;
  }
  const handoff = pending;
  clearPending(false);
  return handoff;
}
