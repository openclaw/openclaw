import {
  isReactionEmoji,
  type SessionReactionEvent,
} from "../../packages/gateway-protocol/src/schema/sessions-reactions.js";
import type { SessionCollaborationScope } from "../config/sessions/session-collaboration-scope.js";
import { setSessionReactionAsync } from "../config/sessions/session-reaction-store.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** The shared local commit/event path. Transport mirroring belongs to the caller. */
export async function commitSessionReaction(params: {
  scope: SessionCollaborationScope;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  messageId: string;
  emoji: string;
  remove?: boolean;
  actor: SessionReactionEvent["actor"];
  /** Agent slots are namespaced independently of editable human profile IDs. */
  identityId?: string;
  sessionKeys?: readonly string[];
  assertCurrent: () => void;
  context: Pick<GatewayRequestContext, "broadcast">;
}) {
  if (!isReactionEmoji(params.emoji)) {
    throw new Error("one emoji grapheme is required");
  }
  params.assertCurrent();
  const write = await setSessionReactionAsync(params.scope, {
    messageId: params.messageId,
    emoji: params.emoji,
    identityId: params.identityId ?? params.actor.id,
    identityLabel: params.actor.label,
    remove: params.remove,
    expectedSessionId: params.sessionId,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (write.changed) {
    params.context.broadcast(
      "session.reaction",
      {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        messageId: params.messageId,
        emoji: params.emoji,
        action: params.remove ? "removed" : "added",
        actor: params.actor,
        reactions: write.reactions,
      } satisfies SessionReactionEvent,
      {
        sessionKeys: [...new Set([params.sessionKey, ...(params.sessionKeys ?? [])])].toSorted(),
        agentId: params.agentId,
      },
    );
  }
  return write;
}
