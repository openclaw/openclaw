import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  keepVolatileQueuedMessage,
  readChatQueueForScope,
  readQueuedMessageById,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  captureChatConnectionOwner,
  setChatError,
  waitForQueuedChatHistory,
} from "./chat-send-queue-state.ts";

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
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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

function consumeInitialTurnHandoff(sessionKey: string): InitialTurnHandoff | null {
  if (!pending || !areUiSessionKeysEquivalent(pending.sessionKey, sessionKey)) {
    return null;
  }
  const handoff = pending;
  clearPending(false);
  return handoff;
}

export function admitInitialTurnHandoff(host: ChatHost, sessionKey: string): boolean {
  const handoff = consumeInitialTurnHandoff(sessionKey);
  if (!handoff) {
    return false;
  }
  const { item, retryAfter } = handoff;
  const queue = readChatQueueForScope(host, sessionKey, item.agentId);
  const alreadyQueued = queue.some((entry) => entry.id === item.id);
  if (!alreadyQueued) {
    keepVolatileQueuedMessage(host, sessionKey, item, item.agentId, { retryable: true });
  }
  if (retryAfter) {
    const expected = readQueuedMessageById(host, item.id);
    const client = host.client;
    const isCurrent = () =>
      host.connected &&
      host.client === client &&
      visibleSessionMatches(host, sessionKey, item.agentId);
    void retryAfter
      .then(async (confirmed) => {
        if (!confirmed || !isCurrent()) {
          return;
        }
        const ownsConnection = captureChatConnectionOwner(host);
        const composerOwner = host.captureComposerRecoveryOwner?.();
        const canDispatch = () =>
          isCurrent() && ownsConnection() && composerOwner?.resolveOwner() === host;
        const { retryQueuedChatMessage } = await import("./chat-send-actions.ts");
        const current = readQueuedMessageById(host, item.id);
        if (
          !expected ||
          !current ||
          !sameQueuedDeliveryVersion(expected, current) ||
          !canDispatch()
        ) {
          return;
        }
        const history = waitForQueuedChatHistory(host, current, sessionKey);
        if (history && !(await history)) {
          return;
        }
        // History publication can wake another queue writer before this continuation.
        const retained = readQueuedMessageById(host, item.id);
        if (retained && sameQueuedDeliveryVersion(expected, retained) && canDispatch()) {
          await retryQueuedChatMessage(host, item.id, canDispatch);
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setChatError(host, formatUiError(error));
        }
      });
  }
  return !alreadyQueued;
}
