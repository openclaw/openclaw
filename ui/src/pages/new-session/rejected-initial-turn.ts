import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { admitStoredChatComposerQueueItem } from "../chat/composer-persistence.ts";
import { prepareInitialTurnHandoff } from "../chat/initial-turn-handoff.ts";

/** Returns true when attachment payload ownership moved to the volatile handoff. */
export function retainRejectedInitialTurn(options: {
  agentId: string;
  attachments: ChatAttachment[];
  context: ApplicationContext;
  error: string;
  message: string;
  mentions?: readonly HumanMention[];
  sessionKey: string;
  sessionId?: string;
  retryAfter?: Promise<boolean>;
}): boolean {
  const gateway = options.context.gateway.snapshot;
  const rejectedItem = {
    id: generateUUID(),
    text: options.message,
    ...(options.mentions?.length ? { mentions: options.mentions } : {}),
    attachments: options.attachments,
    createdAt: Date.now(),
    kind: "queued" as const,
    refreshSessions: true,
    sendAttempts: 1,
    sendError: options.error,
    sendState: "failed" as const,
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
    agentId: normalizeAgentId(options.agentId),
  };
  // The rejected turn already has a server-created destination; never resolve
  // it against the defaults of a later selected route.
  const host = {
    settings: options.context.gateway.connection,
    client: gateway.client,
    connected: gateway.phase === "connected",
    assistantAgentId: gateway.assistantAgentId,
    agentsList: options.context.agents.state.agentsList,
    hello: gateway.hello,
  };
  const ownedItem = { ...rejectedItem, storageScope: outboxStorageScope(host) };
  const admission = {
    ...captureChatOutboxAdmission(host, rejectedItem.sessionKey, rejectedItem.agentId),
    scope: { sessionKey: rejectedItem.sessionKey, agentId: rejectedItem.agentId },
    awaitingDefaults: false,
  };
  const persisted = admitStoredChatComposerQueueItem(host, admission, ownedItem);
  if (!persisted || options.retryAfter) {
    // The pane owns delivery, including volatile payloads that cannot fit in storage.
    prepareInitialTurnHandoff(
      options.sessionKey,
      { ...ownedItem, sendRunId: generateUUID() },
      options.retryAfter,
    );
  }
  return !persisted;
}
