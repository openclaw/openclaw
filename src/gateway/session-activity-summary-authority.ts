import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveUtilityModelSelectionForAgent } from "../agents/utility-model.js";
import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileCatalog,
} from "../state/user-profile-list.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { captureChannelOperatorRunAuthority } from "./operator-run-authority.js";

// Committed config advances and role assignments publish here; in-place config
// mutation makes object identity unusable as a fence.
let policyEpoch = 0;
let watchingPolicy = false;
const readPolicyEpoch = () => {
  if (!watchingPolicy) {
    watchingPolicy = true;
    onOperatorRolePolicyChanged(() => {
      policyEpoch += 1;
    });
  }
  return policyEpoch;
};

/**
 * Why a session owner may not run a recap, fenced by the facts that decided it:
 * role policy and config publications, user profiles, and the session owner.
 */
export type ActivitySummaryRefusal = {
  reason: "profile-unavailable" | "agent-denied" | "role-policy";
  policyEpoch: number;
  profileVersion: number;
  ownerProfileId?: string;
};

/**
 * The refusal while it still holds: until policy, a profile, or the owner changes,
 * with no retry. A role-policy answer also reads the published catalog, which no
 * fence covers, so it is never held and the next activity asks again.
 */
export function heldActivitySummaryRefusal(
  refusal: ActivitySummaryRefusal | undefined,
  entry: Pick<SessionEntry, "owner" | "createdActor">,
): ActivitySummaryRefusal | undefined {
  return refusal &&
    refusal.reason !== "role-policy" &&
    refusal.policyEpoch === readPolicyEpoch() &&
    refusal.profileVersion === readUserProfileVersion() &&
    refusal.ownerProfileId === sessionPersonalProfileId(entry)
    ? refusal
    : undefined;
}

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
      throw new Error("session owner is no longer current");
    }
  };
  return {
    operatorOwned: Boolean(profileId),
    assertCurrent: assertOwnerCurrent,
    /**
     * The owner's run authority, or why the owner may not run a recap now. A
     * refusal is a state for the caller to hold until config or role changes,
     * never a retry; other disabled reasons stay with the caller's selection.
     */
    async prepare(
      this: void,
    ): Promise<
      | { operatorAuthority?: AdmittedRunOperatorAuthority; refused?: never }
      | { refused: ActivitySummaryRefusal; operatorAuthority?: never }
    > {
      assertOwnerCurrent();
      if (!profileId) {
        return {};
      }
      // Read the fence first so a change committed during preparation lifts the refusal.
      const fence = { policyEpoch: readPolicyEpoch(), profileVersion: readUserProfileVersion() };
      const refuse = (reason: ActivitySummaryRefusal["reason"]) => ({
        refused: { reason, ...fence, ownerProfileId: profileId },
      });
      const prepared = await prepareUserProfileCatalog();
      catalog = prepared;
      assertOwnerCurrent();
      const original = prepared.readCurrentIdentity(profileId);
      if (!original) {
        return refuse("profile-unavailable");
      }
      const canonicalProfileId = original.profileId;
      const assignedRole = original.role || null;
      const githubLogin = original.githubLogin ?? null;
      // Resolve historical aliases once; effect checks retain the same catalog
      // and canonical identity without rebuilding the alias set.
      const source = captureResidentUserProfileAccess(profileId);
      assertOwnerCurrent();
      const profile = source.assertCurrent();
      if (
        profile.id !== canonicalProfileId ||
        (profile.role || null) !== assignedRole ||
        (profile.githubLogin ?? null) !== githubLogin
      ) {
        // A read race between the catalog and the resident row, not a refusal.
        throw new Error("session owner's role changed during preparation");
      }
      const role = resolveOperatorRolePolicyForAssignment(
        canonicalProfileId,
        assignedRole,
        getConfig(),
        githubLogin,
        operatorRoleSubject(profile),
      );
      if (role && role.agents !== "*" && !role.agents.includes(agentId)) {
        return refuse("agent-denied");
      }
      authority = captureChannelOperatorRunAuthority({
        profileId: canonicalProfileId,
        canonicalIdentity: { profileId: canonicalProfileId },
        assignedRole,
        githubLogin,
        openclawIdAccountIds: original.openclawIdAccountIds,
        scopes: [],
        gatewayAccessGrant: null,
        getRuntimeConfig: getConfig,
      });
      const utility = resolveUtilityModelSelectionForAgent({
        cfg: getConfig(),
        agentId,
        modelPolicy: authority.modelPolicy,
      });
      return "disabled" in utility && utility.disabled === "role-policy"
        ? refuse("role-policy")
        : { operatorAuthority: authority };
    },
    // The recap owner joins preparation and completion before releasing this lease.
    release(this: void) {
      active = false;
      catalog?.release();
    },
  };
}
