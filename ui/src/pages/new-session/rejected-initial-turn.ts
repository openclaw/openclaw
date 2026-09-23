import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
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
  const admission = {
    scope: { sessionKey: rejectedItem.sessionKey, agentId: rejectedItem.agentId },
    awaitingDefaults: false,
  };
  const persisted = admitStoredChatComposerQueueItem(
    {
      settings: loadSettings(),
      assistantAgentId: gateway.assistantAgentId,
      agentsList: options.context.agents.state.agentsList,
      hello: gateway.hello,
    },
    admission,
    rejectedItem,
  );
  if (!persisted || options.retryAfter) {
    // The pane owns delivery, including volatile payloads that cannot fit in storage.
    prepareInitialTurnHandoff(
      options.sessionKey,
      { ...rejectedItem, sendRunId: generateUUID() },
      options.retryAfter,
    );
  }
  return !persisted;
}
