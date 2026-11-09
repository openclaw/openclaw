// Member display belongs to the Gateway's canonical profile owner, not expiring invitations.
import type { StoredClaw } from "./claw-store.js";

/** Display-only facts; none of these fields grant access or create an email alias. */
type MemberProfileDisplay = { id: string; displayName: string | null; email: string | null };

/** The existing profile owner, injectable alongside the claw store in isolated authority tests. */
export type OpenClawIdMemberProfiles = {
  save: (input: {
    accountId: string;
    name?: string | null;
    email?: string | null;
  }) => Promise<unknown>;
  read: (accountIds: readonly string[]) => Promise<Record<string, MemberProfileDisplay>>;
};

/** Routes profile persistence and reads through the existing shared-state worker. */
export const canonicalMemberProfiles: OpenClawIdMemberProfiles = {
  async save(input) {
    const { ensureCanonicalUserProfileForOpenClawIdIdentity } =
      await import("../../state/user-profile-openclaw-id.js");
    return ensureCanonicalUserProfileForOpenClawIdIdentity(input);
  },
  async read(accountIds) {
    const { readOpenClawIdUserProfiles } = await import("../../state/user-profile-openclaw-id.js");
    return readOpenClawIdUserProfiles(accountIds);
  },
};

/** Retains approved profiles before deleting reports; approval times follow membership lifetime. */
export async function retainMemberProfiles(
  previous: StoredClaw | undefined,
  next: StoredClaw,
  profiles: OpenClawIdMemberProfiles,
): Promise<StoredClaw> {
  const members = next.authority?.members ?? {};
  const accountIds = Object.keys(members);
  const approval = (record: StoredClaw | undefined, id: string) =>
    record?.member_approved_at && Object.hasOwn(record.member_approved_at, id)
      ? record.member_approved_at[id]
      : undefined;
  const reports = Object.entries(next.invite_reports ?? {});
  const hasInvite = (id: string) =>
    Object.hasOwn(next.authority?.invites ?? {}, id) ||
    Object.hasOwn(next.authority?.node_invites ?? {}, id);
  const needsReports = reports.some(
    ([id, entry]) =>
      !hasInvite(id) ||
      (entry.resolution === "approved" && (entry.email !== null || entry.display_name !== null)),
  );
  if (
    !needsReports &&
    accountIds.length === Object.keys(next.member_approved_at ?? {}).length &&
    accountIds.every((id) => approval(next, id) !== undefined)
  ) {
    return next;
  }
  const approvedAt = new Map<string, number | null>();
  // Include reports about to be swept, so pre-partition records retain their display details too.
  const source = Object.entries({ ...previous?.invite_reports, ...next.invite_reports });
  for (const accountId of accountIds) {
    const currentApproval = approval(next, accountId);
    const known = currentApproval === undefined ? approval(previous, accountId) : currentApproval;
    const existingMember = Object.hasOwn(previous?.authority?.members ?? {}, accountId);
    const report = source
      .filter(
        ([inviteId, entry]) =>
          entry.account_id === accountId &&
          entry.resolution === "approved" &&
          ((existingMember && known === undefined) ||
            previous?.invite_reports?.[inviteId]?.resolution !== "approved"),
      )
      .map(([, entry]) => entry)
      .toSorted((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))[0];
    if (known === undefined || report?.email || report?.display_name) {
      // Profile creation never grants membership; only the subsequent claw commit may do that.
      // A failed profile write preserves the previous record, including its source report.
      await profiles.save({
        accountId,
        // Null reported fields mean unavailable, not a request to erase a retained profile.
        ...(report?.display_name ? { name: report.display_name } : {}),
        ...(report?.email ? { email: report.email } : {}),
      });
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
    ...next,
    member_approved_at: Object.fromEntries(approvedAt),
    ...(next.invite_reports ? { invite_reports: inviteReports } : {}),
  };
}
