import { runtimeConfigPublication } from "../../config/runtime-config-publication.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { linkCanonicalOpenClawIdUserProfile } from "../../state/user-profile-openclaw-id.js";
import { operatorRoleSubject } from "../operator-role-enforcement.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRoleSelection,
} from "../operator-role-policy.js";
// Member display belongs to the Gateway's canonical profile owner, not expiring invitations.
import type { StoredClaw } from "./claw-store.js";

/** Display-only facts; none of these fields grant access or create an email alias. */
type MemberProfileDisplay = {
  id: string;
  displayName: string | null;
  email: string | null;
  effectiveRole?: string;
};

/** The existing profile owner, injectable alongside the claw store in isolated authority tests. */
export type OpenClawIdMemberProfiles = {
  save: (input: {
    accountId: string;
    name?: string | null;
    email?: string | null;
  }) => Promise<unknown>;
  setRole: (
    accountId: string,
    role: string,
    onlyIfUnassigned: boolean,
    isCurrent?: () => boolean,
  ) => Promise<void>;
  read: (accountIds: readonly string[]) => Promise<Record<string, MemberProfileDisplay>>;
  inviteProfiles: () => Promise<Array<{ id: string; displayName: string | null }>>;
  link: (
    input: Parameters<typeof linkCanonicalOpenClawIdUserProfile>[0],
  ) => ReturnType<typeof linkCanonicalOpenClawIdUserProfile>;
};

/** Routes profile persistence and reads through the existing shared-state worker. */
export const canonicalMemberProfiles: OpenClawIdMemberProfiles = {
  async inviteProfiles() {
    const { readOpenClawIdInviteProfiles } =
      await import("../../state/user-profile-openclaw-id.js");
    return readOpenClawIdInviteProfiles();
  },
  async link(input) {
    const { linkCanonicalOpenClawIdUserProfile } =
      await import("../../state/user-profile-openclaw-id.js");
    return linkCanonicalOpenClawIdUserProfile(input);
  },
  async save(input) {
    const { ensureCanonicalUserProfileForOpenClawIdIdentity } =
      await import("../../state/user-profile-openclaw-id.js");
    return ensureCanonicalUserProfileForOpenClawIdIdentity(input);
  },
  async setRole(accountId, role, onlyIfUnassigned, isCurrent = () => true) {
    const publication = runtimeConfigPublication.current;
    const { ensureCanonicalUserProfileForOpenClawIdIdentity, setCanonicalUserProfileRole } =
      await import("../../state/user-profile-writes.js");
    const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({ accountId });
    const { prepareUserProfileRoleAuthority } =
      await import("../../state/user-channel-identity-operations.js");
    const target = await prepareUserProfileRoleAuthority(profile.id);
    if (!target) {
      throw new Error("Member profile is unavailable; retry the role assignment.");
    }
    if (!isCurrent()) {
      return;
    }
    if (!onlyIfUnassigned || !target.role) {
      const config = getRuntimeConfigSnapshot() ?? {};
      const policy = config.gateway?.roles?.definitions[role];
      const importingSources = onlyIfUnassigned && !target.role && policy !== undefined;
      const assertCurrent = () => {
        if (
          !isCurrent() ||
          !target.isCurrent() ||
          (importingSources && runtimeConfigPublication.current !== publication)
        ) {
          throw new Error(
            "Member profile changed or role policy changed; retry the role assignment.",
          );
        }
      };
      if (importingSources) {
        const { migrateLegacyMemberSessionSources } =
          await import("./member-source-role-import-sessions.js");
        const { migrateSharedOpenClawIdMemberSources } =
          await import("./member-source-role-import-shared.js");
        const input = { profileId: profile.id, accountId, role, policy };
        // A partial import remains unassigned and can be retried: rewritten sources
        // cannot pass recovery's assignment check before this final profile commit.
        await migrateLegacyMemberSessionSources(input, config, assertCurrent);
        await migrateSharedOpenClawIdMemberSources(input, assertCurrent);
      }
      await setCanonicalUserProfileRole(profile.id, role, {
        assertCurrent,
        onCommitted: (id) => invalidateOperatorRolePolicy(id, { roleOnly: true }),
      });
    }
  },
  async read(accountIds) {
    const { readOpenClawIdUserProfiles } = await import("../../state/user-profile-openclaw-id.js");
    const profiles = await readOpenClawIdUserProfiles(accountIds);
    const { prepareUserProfileRoleAuthority } =
      await import("../../state/user-channel-identity-operations.js");
    const config = getRuntimeConfigSnapshot() ?? {};
    return Object.fromEntries(
      await Promise.all(
        Object.entries(profiles).map(async ([id, profile]) => {
          const authority = await prepareUserProfileRoleAuthority(profile.id);
          const selection = resolveOperatorRoleSelection(
            profile.id,
            authority?.role ?? null,
            config,
            authority?.githubLogin ?? null,
            operatorRoleSubject(authority),
          );
          return [
            id,
            { ...profile, effectiveRole: selection.effectiveRole ?? authority?.role ?? undefined },
          ];
        }),
      ),
    );
  },
};

/** Retains approved profiles before deleting reports; approval times follow membership lifetime. */
export async function retainMemberProfiles(
  previous: StoredClaw | undefined,
  next: StoredClaw,
  profiles: OpenClawIdMemberProfiles,
  memberRolesEnabled: () => boolean,
): Promise<{ record: StoredClaw; assertCurrent: () => void }> {
  const publication = runtimeConfigPublication.current;
  const rolesCurrent = () =>
    memberRolesEnabled() && runtimeConfigPublication.current === publication;
  let hasRoleInitialization = false;
  // The claw marker shares the import's feature and config lifetime through its durable commit.
  const assertCurrent = () => {
    if (hasRoleInitialization && !rolesCurrent()) {
      throw new Error("OpenClaw ID member role import changed; retry the role assignment.");
    }
  };
  const members = next.authority?.members ?? {};
  const accountIds = Object.keys(members);
  const approval = (record: StoredClaw | undefined, id: string) =>
    record?.member_approved_at && Object.hasOwn(record.member_approved_at, id)
      ? record.member_approved_at[id]
      : undefined;
  const rolesInitialized = Object.fromEntries(
    accountIds.filter((id) => next.member_profile_roles?.[id]).map((id) => [id, true]),
  );
  const needsRoles = rolesCurrent() && accountIds.some((id) => !rolesInitialized[id]);
  const reports = Object.entries(next.invite_reports ?? {});
  const hasInvite = (id: string) =>
    Object.hasOwn(next.authority?.invites ?? {}, id) ||
    Object.hasOwn(next.authority?.node_invites ?? {}, id);
  const needsReports = reports.some(
    ([id, entry]) =>
      !hasInvite(id) ||
      (entry.resolution === "approved" &&
        (entry.email !== null ||
          entry.display_name !== null ||
          previous?.invite_reports?.[id]?.resolution !== "approved")),
  );
  if (
    !needsReports &&
    !needsRoles &&
    accountIds.length === Object.keys(next.member_approved_at ?? {}).length &&
    accountIds.every((id) => approval(next, id) !== undefined)
  ) {
    return { record: next, assertCurrent };
  }
  const approvedAt = new Map<string, number | null>();
  // Include reports about to be swept, so pre-partition records retain their display details too.
  const source = Object.entries({ ...previous?.invite_reports, ...next.invite_reports });
  for (const accountId of accountIds) {
    const currentApproval = approval(next, accountId);
    const known = currentApproval === undefined ? approval(previous, accountId) : currentApproval;
    const existingMember = Object.hasOwn(previous?.authority?.members ?? {}, accountId);
    const approved = source
      .filter(
        ([inviteId, entry]) =>
          entry.account_id === accountId &&
          entry.resolution === "approved" &&
          ((existingMember && known === undefined) ||
            previous?.invite_reports?.[inviteId]?.resolution !== "approved"),
      )
      .toSorted(([, a], [, b]) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))[0];
    const report = approved?.[1];
    if (approved && report?.existingProfile) {
      const linked = await profiles.link({
        profileId: report.existingProfile.id,
        accountId,
        email: report.email,
      });
      if (!linked.ok) {
        const reasons = {
          owner_profile:
            "The selected profile is the shared owner. The member joined with their OpenClaw ID profile instead.",
          profile_changed:
            "The selected profile was removed or merged. The member joined with their OpenClaw ID profile instead.",
          linked_elsewhere:
            "This OpenClaw ID account already belongs to another profile. The member kept that profile instead.",
          profile_linked:
            "The selected profile is now linked to another OpenClaw ID account. The member joined with their OpenClaw ID profile instead.",
        };
        const index = reports.findIndex(([id]) => id === approved[0]);
        if (index !== -1) {
          reports[index] = [
            approved[0],
            {
              ...report,
              existingProfile: { ...report.existingProfile, fallbackReason: reasons[linked.code] },
            },
          ];
        }
      }
    }
    if (known === undefined || report?.existingProfile || report?.email || report?.display_name) {
      // Profile creation never grants membership; only the subsequent claw commit may do that.
      // A failed profile write preserves the previous record, including its source report.
      await profiles.save({
        accountId,
        // Null reported fields mean unavailable, not a request to erase a retained profile.
        ...(report?.display_name ? { name: report.display_name } : {}),
        ...(report?.email ? { email: report.email } : {}),
      });
    }
    const freshApproval =
      approved && previous?.invite_reports?.[approved[0]]?.resolution !== "approved";
    if (rolesCurrent() && (!rolesInitialized[accountId] || freshApproval)) {
      // Upgrade imports the label once, preserving explicit profile assignments. New
      // admission and owner-signed role changes assign the requested profile role.
      await profiles.setRole(
        accountId,
        members[accountId]!.role,
        !freshApproval &&
          existingMember &&
          previous?.authority?.members[accountId]?.role === members[accountId]!.role,
        rolesCurrent,
      );
      if (rolesCurrent()) {
        rolesInitialized[accountId] = true;
        hasRoleInitialization = true;
      }
    }
    // Old direct additions have no recorded approval time; do not invent one during migration.
    const createdAt = Object.hasOwn(previous?.authority?.members ?? {}, accountId)
      ? null
      : Math.floor(Date.now() / 1000);
    approvedAt.set(accountId, known === undefined ? (report?.resolved_at ?? createdAt) : known);
  }
  const inviteReports = Object.fromEntries(
    reports
      .filter(([id]) => hasInvite(id))
      .map(([id, report]) => [
        id,
        report.resolution === "approved" ? { ...report, email: null, display_name: null } : report,
      ]),
  );
  return {
    record: {
      ...next,
      member_approved_at: Object.fromEntries(approvedAt),
      ...(rolesCurrent() ? { member_profile_roles: rolesInitialized } : {}),
      ...(next.invite_reports ? { invite_reports: inviteReports } : {}),
    },
    assertCurrent,
  };
}
