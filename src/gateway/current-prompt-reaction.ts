import { isReactionEmoji } from "../../packages/gateway-protocol/src/schema/sessions-reactions.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import {
  getUserTurnTranscriptAdmissionOwner,
  type CurrentPromptReaction,
} from "../sessions/user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Captured only by authenticated chat admission, never by channel-route inference. */
export function createCurrentPromptReaction(params: {
  agentId: string;
  sessionKey: string;
  recorder: UserTurnTranscriptRecorder;
  context: Pick<GatewayRequestContext, "broadcast" | "getRuntimeConfig">;
}): CurrentPromptReaction {
  return async (input) => {
    input.assertCurrent();
    // Read the native recorder's committed anchor, not MessageSid, a run ID, or
    // a model-provided transcript identifier. Pending/blocked input has no grant.
    const owner = getUserTurnTranscriptAdmissionOwner(params.recorder);
    const admission = owner?.receipt();
    if (
      !owner ||
      params.recorder.isBlocked() ||
      !admission ||
      admission.agentId !== params.agentId ||
      admission.sessionKey !== params.sessionKey
    ) {
      throw new Error("Current WebChat prompt has not been committed.");
    }
    const assertCurrent = () => {
      input.assertCurrent();
      if (params.recorder.isBlocked() || owner.receipt() !== admission) {
        throw new Error("Current WebChat prompt admission changed.");
      }
    };
    if (!isReactionEmoji(input.emoji)) {
      throw new Error("one emoji grapheme is required");
    }
    if (input.dryRun) {
      return { messageId: admission.entryId, changed: false, reactions: [] };
    }
    const { commitSessionReaction } = await import("./session-reaction-mutation.js");
    assertCurrent();
    const write = await commitSessionReaction({
      scope: {
        agentId: admission.agentId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      },
      sessionKey: params.sessionKey,
      sessionId: admission.sessionId,
      agentId: params.agentId,
      messageId: admission.entryId,
      emoji: input.emoji,
      remove: input.remove,
      actor: {
        type: "agent",
        id: params.agentId,
        label:
          resolveAgentIdentity(params.context.getRuntimeConfig(), params.agentId)?.name ??
          params.agentId,
      },
      identityId: "agent:" + params.agentId,
      context: params.context,
      assertCurrent,
    });
    return { messageId: admission.entryId, changed: write.changed, reactions: write.reactions };
  };
}
