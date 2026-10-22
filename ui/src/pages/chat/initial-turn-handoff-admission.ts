import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { setChatError } from "./chat-history-state.ts";
import {
  keepVolatileQueuedMessage,
  readChatQueueForScope,
  readQueuedMessageById,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { waitForQueuedChatHistory } from "./chat-send-queue-state.ts";
import { takeInitialTurnHandoff } from "./initial-turn-handoff.ts";

export function admitInitialTurnHandoff(host: ChatHost, sessionKey: string): boolean {
  const handoff = takeInitialTurnHandoff(host, sessionKey);
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
