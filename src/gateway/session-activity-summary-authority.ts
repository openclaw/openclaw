import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileCatalog,
} from "../state/user-profile-list.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { captureChannelOperatorRunAuthority } from "./operator-run-authority.js";

/** Bind the session owner's restriction, independently of the viewer requesting a refresh. */
export function createActivitySummaryAuthority({
  agentId,
  getEntry,
  getConfig,
  assertCurrent,
}: {
  agentId: string;
  getEntry: () => Pick<SessionEntry, "owner" | "createdActor">;
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
}) {
  const profileId = sessionPersonalProfileId(getEntry());
  let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  let authority: ReturnType<typeof captureChannelOperatorRunAuthority> | undefined;
  let active = true;
  const assertOwnerCurrent = () => {
    assertCurrent();
    if (!active || sessionPersonalProfileId(getEntry()) !== profileId) {
      throw new Error("Activity recap operator ownership is no longer current");
    }
  };
  return {
    operatorOwned: Boolean(profileId),
    assertCurrent(this: void) {
      assertOwnerCurrent();
      authority?.assertCurrent();
    },
    async prepare(this: void) {
      assertOwnerCurrent();
      if (!profileId) {
        return undefined;
      }
      const prepared = await prepareUserProfileCatalog();
      catalog = prepared;
      assertOwnerCurrent();
      const original = prepared.readCurrentIdentity(profileId);
      if (!original) {
        throw new Error("Activity recap operator profile is unavailable");
      }
      const canonicalProfileId = original.profileId;
      const assignedRole = original.role || null;
      const githubLogin = original.githubLogin ?? null;
      // Resolve historical aliases once; effect checks retain the same catalog
      // and canonical identity without rebuilding the alias set.
      const source = captureResidentUserProfileAccess(profileId);
      authority = captureChannelOperatorRunAuthority({
        profileId: canonicalProfileId,
        assignedRole,
        githubLogin,
        scopes: [],
        gatewayAccessGrant: null,
        getRuntimeConfig: getConfig,
        assertCurrent: () => {
          assertOwnerCurrent();
          const profile = source.assertCurrent();
          if (
            profile.id !== canonicalProfileId ||
            (profile.role || null) !== assignedRole ||
            (profile.githubLogin ?? null) !== githubLogin
          ) {
            throw new Error("Activity recap operator role changed");
          }
          const role = resolveOperatorRolePolicyForAssignment(
            canonicalProfileId,
            assignedRole,
            getConfig(),
            githubLogin,
          );
          if (role && role.agents !== "*" && !role.agents.includes(agentId)) {
            throw new Error("Activity recap operator role cannot access this agent");
          }
        },
      });
      return authority;
    },
    // The recap owner joins preparation and completion before releasing this lease.
    release(this: void) {
      active = false;
      catalog?.release();
    },
  };
}
