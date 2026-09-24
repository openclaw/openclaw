import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import type { createHumanMentionPolicy } from "./human-mention-policy.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import { readOperatorRolePolicyRevision } from "./operator-role-policy.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";

/** Bind both durable commits to the same physical session and live recipient authority. */
export function createCommittedMentionAuthority(params: {
  input: MentionCommittedInput;
  resolved: SessionSharingTarget;
  recipients: readonly { profileId: string; id: string | null }[];
  policy: ReturnType<typeof createHumanMentionPolicy>;
  cfg: OpenClawConfig;
  getRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
}) {
  const { input, resolved, recipients, policy, cfg, assertCurrent } = params;
  const admittedProfiles = readUserProfileVersion();
  const admittedRoles = readOperatorRolePolicyRevision();
  const assertPolicy = () => {
    assertCurrent();
    if (
      admittedProfiles !== readUserProfileVersion() ||
      admittedRoles !== readOperatorRolePolicyRevision() ||
      cfg !== params.getRuntimeConfig()
    ) {
      throw new Error("Committed mention recipient policy changed");
    }
  };
  const assertTarget = () => {
    assertPolicy();
    const latest = policy.resolveTarget({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    });
    if (
      !latest ||
      latest.storePath !== resolved.storePath ||
      latest.storeKey !== resolved.storeKey ||
      latest.entry.sessionId !== input.sessionId ||
      latest.entry.incognito === true ||
      isIncognitoSessionKey(latest.canonicalKey)
    ) {
      throw new Error("Committed mention session changed");
    }
    const current = {
      agentId: latest.agentId,
      sessionKey: latest.canonicalKey,
      entry: latest.entry,
    };
    for (const recipient of recipients) {
      if (
        recipient.id &&
        policy.recipientProfile(recipient.profileId, current, cfg)?.profileId !==
          recipient.profileId
      ) {
        throw new Error("Committed mention recipient access changed");
      }
    }
  };

  return { assertPolicy, assertTarget };
}
