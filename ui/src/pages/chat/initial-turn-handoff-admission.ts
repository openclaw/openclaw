import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { setChatError } from "./chat-history-state.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import {
  keepVolatileQueuedMessage,
  readChatQueueForScope,
  readQueuedMessageById,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { waitForQueuedChatHistory } from "./chat-send-queue-state.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { reportChatComposerDraftStorageError } from "./composer-persistence-feedback.ts";
import { admitChatSubmission } from "./history-merge.ts";
import { takeInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

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
    reportChatComposerDraftStorageError(host);
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

/** The run sessions.create acknowledged for the retained first prompt. Read it
 *  before transcript hydration or admission: a cached receipt retires the prompt. */
export function readAcknowledgedInitialRun(host: Parameters<typeof adoptStartedChatRun>[0]) {
  const initial = host.chatSubmissions?.readInitial(
    host.sessionKey,
    host.client ?? null,
    host.currentSessionId,
  );
  return initial?.pending
    ? {
        id: initial.pendingRunId,
        startedAt: initial.message.timestamp,
        sessionId: initial.sessionId,
      }
    : undefined;
}

/** Restore initial-turn presentation after the caller has applied cached history or agent scope. */
export function admitInitialChatTurn(
  host: ChatPageHost,
  run: ReturnType<typeof readAcknowledgedInitialRun>,
): void {
  admitInitialTurnHandoff(host, host.sessionKey);
  admitChatSubmission(host, getChatPendingInputs(host)?.page.items);
  // Cached history can bind a replacement physical session; only adopt this session's ACK.
  if (
    run &&
    !host.chatRunId &&
    (!run.sessionId || !host.currentSessionId || run.sessionId === host.currentSessionId)
  ) {
    adoptStartedChatRun(host, run.id, run.startedAt);
  }
}
