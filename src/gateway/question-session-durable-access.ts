import type {
  DurableQuestionSessionBinding,
  QuestionSessionAccess,
} from "./question-session-access.types.js";
import { authorizeOwnSessionMutation } from "./session-sharing-policy.js";

/** Restored questions bind a conversation generation, not the retired asking run. */
export function createDurableQuestionSessionAccess(
  binding: DurableQuestionSessionBinding,
): QuestionSessionAccess {
  const original = structuredClone(binding);
  let retired = false;
  const assertSourceCurrent = () => {
    if (retired) {
      throw new Error("Durable question observation was retired");
    }
  };
  return {
    agentId: original.agentId,
    sessionKey: original.sessionKey,
    durableBinding: original,
    durableCustody: true,
    canSelect: (client) =>
      Boolean(
        original.profileId &&
        client &&
        !client.invalidated &&
        (client.connect.role ?? "operator") === "operator" &&
        !authorizeOwnSessionMutation({
          client,
          target: null,
          expectedProfileId: original.profileId,
        }),
      ),
    assertSourceCurrent,
    assertCurrent: (current) => {
      assertSourceCurrent();
      current.assertCurrent();
      const next = current.target;
      const identity = current.read.result.databaseIdentity;
      if (
        !identity ||
        identity.identity !== original.databaseIdentity.identity ||
        identity.birthtime !== original.databaseIdentity.birthtime ||
        current.read.database.path !== original.databasePath ||
        next?.agentId !== original.agentId ||
        next.canonicalKey !== original.sessionKey ||
        next.storePath !== original.storePath ||
        next.entry.sessionId !== original.sessionId ||
        next.entry.lifecycleRevision !== original.lifecycleRevision ||
        next.entry.incognito
      ) {
        retired = true;
        throw new Error("Durable question conversation generation changed");
      }
    },
    release: () => {
      retired = true;
    },
  };
}
