/**
 * AGENT INBOX
 *
 * Lightweight in-memory message store for inter-agent communication.
 * When sessions_send fires a message, it writes to the inbox immediately
 * so the target agent can read it via sessions_inbox without waiting for
 * a full agent run (LLM inference) to complete.
 */

export interface InboxMessage {
  id: string;
  fromAgentId: string;
  fromSessionKey: string;
  toAgentId: string;
  toSessionKey: string;
  message: string;
  timestamp: number;
}

// Map<targetSessionKey, InboxMessage[]>
const inboxes = new Map<string, InboxMessage[]>();

// Also index by agentId for broader lookup
const agentInboxes = new Map<string, InboxMessage[]>();

let messageCounter = 0;

export function deliverToInbox(params: {
  fromAgentId: string;
  fromSessionKey: string;
  toAgentId: string;
  toSessionKey: string;
  message: string;
}): InboxMessage {
  const msg: InboxMessage = {
    id: `inbox:${++messageCounter}:${Date.now()}`,
    fromAgentId: params.fromAgentId,
    fromSessionKey: params.fromSessionKey,
    toAgentId: params.toAgentId,
    toSessionKey: params.toSessionKey,
    message: params.message,
    timestamp: Date.now(),
  };

  // Store by target session key
  let sessionMessages = inboxes.get(params.toSessionKey);
  if (!sessionMessages) {
    sessionMessages = [];
    inboxes.set(params.toSessionKey, sessionMessages);
  }
  sessionMessages.push(msg);

  // Also store by target agent ID (for broader discovery)
  let agentMessages = agentInboxes.get(params.toAgentId);
  if (!agentMessages) {
    agentMessages = [];
    agentInboxes.set(params.toAgentId, agentMessages);
  }
  agentMessages.push(msg);

  return msg;
}

export function readInboxBySession(sessionKey: string): InboxMessage[] {
  return inboxes.get(sessionKey) ?? [];
}

export function readInboxByAgent(agentId: string): InboxMessage[] {
  return agentInboxes.get(agentId) ?? [];
}

export function clearInboxForSession(sessionKey: string): number {
  const messages = inboxes.get(sessionKey);
  const count = messages?.length ?? 0;
  inboxes.delete(sessionKey);
  return count;
}

export function clearInboxForAgent(agentId: string): number {
  const messages = agentInboxes.get(agentId);
  const count = messages?.length ?? 0;
  // Also clean session-keyed entries for this agent
  if (messages) {
    for (const msg of messages) {
      const sessionMessages = inboxes.get(msg.toSessionKey);
      if (sessionMessages) {
        const filtered = sessionMessages.filter((m) => m.id !== msg.id);
        if (filtered.length === 0) {
          inboxes.delete(msg.toSessionKey);
        } else {
          inboxes.set(msg.toSessionKey, filtered);
        }
      }
    }
  }
  agentInboxes.delete(agentId);
  return count;
}

export function resetInboxForTests(): void {
  inboxes.clear();
  agentInboxes.clear();
  messageCounter = 0;
}
