import { isDeepStrictEqual } from "node:util";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { deferOpenClawAgentPostCommitPublication } from "../../state/openclaw-agent-db.js";
import {
  prepareUserProfileCatalog,
  readUserProfileAliases,
} from "../../state/user-profile-list.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { updatePreparedSessionProfileInvolvement } from "./session-accessor.sqlite-involvement.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { runSessionCollaborationWrite } from "./session-sharing-store.async.js";
import type { SessionInvolvementMutation } from "./session-sharing-store.types.js";

type InvolvementParams = SessionInvolvementMutation & { assertCurrent?: () => void };

/** Released v2026.9.8 MentionInbox.recordCommittedInput completion contract. */
export function updateSessionProfileInvolvement(
  scope: SessionAccessScope,
  params: InvolvementParams,
): boolean {
  const profiles = [...new Set(params.profileIds)].map((profileId) => ({
    profileId,
    aliases: [...readUserProfileAliases(profileId, { env: scope.env })],
  }));
  return updatePreparedSessionProfileInvolvement(scope, params, profiles).accepted;
}

export async function updateSessionProfileInvolvementAsync(
  scope: SessionCollaborationScope,
  { assertCurrent, ...params }: InvolvementParams,
): Promise<boolean> {
  const captured = structuredClone(params);
  let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  let profiles: { profileId: string; aliases: string[] }[] | undefined;
  const selectProfiles = (prepared: NonNullable<typeof catalog>) =>
    [...new Set(captured.profileIds)].map((profileId) => {
      const identity = prepared.readCurrentIdentity(profileId);
      return {
        profileId: identity?.profileId ?? profileId,
        // Preserve native ordering for mention generations with equal timestamps.
        aliases: [...new Set([profileId, ...(identity?.aliases ?? [])])],
      };
    });
  try {
    return await runSessionCollaborationWrite(
      scope,
      { type: "involvement", input: { scope, params: captured, profiles: [] } },
      (result, location, database, currentKeys) => {
        if (result.changed && database && (!currentKeys || currentKeys.has(location.sessionKey))) {
          publishSessionEntryCacheInvalidation(database, {
            sessionKey: location.sessionKey,
            facts: { kind: "unchanged" },
          });
          deferOpenClawAgentPostCommitPublication(database, () =>
            emitSessionLifecycleEvent({
              agentId: location.agentId,
              sessionKey: location.sessionKey,
              reason: "involvement",
            }),
          );
        }
        return result.accepted;
      },
      () => {
        assertCurrent?.();
        if (catalog && profiles && !isDeepStrictEqual(selectProfiles(catalog), profiles)) {
          throw new Error("Session involvement profile aliases changed before commit");
        }
      },
      async (_operation, capturedScope) => {
        catalog = await prepareUserProfileCatalog({ env: capturedScope.env });
        profiles = selectProfiles(catalog);
        return { scope: capturedScope, params: captured, profiles };
      },
    );
  } finally {
    catalog?.release();
  }
}
