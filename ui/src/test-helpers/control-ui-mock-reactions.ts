import type { MessageReactionSummary, SessionSharingIdentity } from "@openclaw/gateway-protocol";
import type { createControlUiSessionFixtures } from "./control-ui-session-fixtures.ts";

// Serialized alongside the Gateway mock; this owner retains per-instance reactions.
export function createControlUiMockReactions(
  input: {
    sessionKey: string;
    defaultAgentId: string;
    sessionReactions: Record<string, Record<string, MessageReactionSummary[]>>;
    sessions: Pick<ReturnType<typeof createControlUiSessionFixtures>, "read">;
    actor: SessionSharingIdentity;
    emit: (payload: unknown) => void;
  },
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  const scenario = input;
  const sessions = input.sessions;
  const reactionSessions = new Map<string, Record<string, MessageReactionSummary[]>>();
  function sessionIdentity(key: string): string {
    const row = sessions.read(key);
    return JSON.stringify([row.key, row.sessionId]);
  }
  for (const [key, reactions] of Object.entries(scenario.sessionReactions)) {
    reactionSessions.set(sessionIdentity(key), structuredClone(reactions));
  }
  function reactionsForSession(key: string): Record<string, MessageReactionSummary[]> {
    const identity = sessionIdentity(key);
    let reactions = reactionSessions.get(identity);
    if (!reactions) {
      reactions = {};
      reactionSessions.set(identity, reactions);
    }
    return reactions;
  }

  function set(params: Record<string, unknown>) {
    const key = typeof params.sessionKey === "string" ? params.sessionKey : scenario.sessionKey;
    const row = sessions.read(key);
    const messageId = String(params.messageId);
    const emoji = String(params.emoji);
    const actor = input.actor;
    const summaries = reactionsForSession(key);
    let reactions = summaries[messageId] ?? [];
    let reaction = reactions.find((entry) => entry.emoji === emoji);
    if (params.remove === true) {
      if (reaction) {
        reaction.identities = reaction.identities.filter((identity) => identity.id !== actor.id);
        reaction.count = reaction.identities.length;
        reactions = reactions.filter((entry) => entry.count > 0);
      }
    } else {
      if (!reaction) {
        reaction = { emoji, count: 0, identities: [] };
        reactions.push(reaction);
      }
      if (!reaction.identities.some((identity) => identity.id === actor.id)) {
        reaction.identities.push({ id: actor.id, label: actor.label });
        reaction.count = reaction.identities.length;
      }
    }
    summaries[messageId] = reactions;
    input.emit({
      sessionKey: row.key,
      agentId: typeof params.agentId === "string" ? params.agentId : scenario.defaultAgentId,
      sessionId: row.sessionId,
      messageId,
      emoji,
      action: params.remove === true ? "removed" : "added",
      actor,
      reactions,
    });
    return {
      messageId,
      reactions,
      mirror: { status: "skipped", reason: "no channel transport" },
    };
  }
  return {
    set,
    list(params: unknown) {
      const key =
        isRecord(params) && typeof params.sessionKey === "string"
          ? params.sessionKey
          : input.sessionKey;
      return { sessionId: sessions.read(key).sessionId, reactions: reactionsForSession(key) };
    },
    applyEvent(payload: unknown) {
      if (
        isRecord(payload) &&
        typeof payload.sessionKey === "string" &&
        typeof payload.messageId === "string" &&
        Array.isArray(payload.reactions) &&
        sessions.read(payload.sessionKey).sessionId === payload.sessionId
      ) {
        reactionsForSession(payload.sessionKey)[payload.messageId] = payload.reactions;
      }
    },
  };
}
