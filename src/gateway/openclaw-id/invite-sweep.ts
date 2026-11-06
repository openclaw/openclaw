// Expired invitation cleanup and display outcomes; membership profiles have a separate lifetime.
import {
  parseStatement,
  withoutSpentInvites,
  type AuthorityEvent,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw, InviteReport } from "./claw-store.js";
import { expirePendingRedemptions } from "./invite-expiry.js";

// Sweeps invites before a write sees the state: consumes expired pending redemptions
// (recorded as expired), then deletes spent invite records with their reports, so
// stored invites stay within the protocol's cap. Returns the record to write from
// and the owner notices.
export function withSweptInvites(
  record: StoredClaw & { authority: NonNullable<StoredClaw["authority"]> },
  now: number,
): {
  record: StoredClaw & { authority: NonNullable<StoredClaw["authority"]> };
  events: AuthorityEvent[];
} {
  const swept = expirePendingRedemptions(record.authority, now);
  const spent = withoutSpentInvites(swept.state, now);
  if (swept.expired.length === 0 && spent.removed.length === 0) {
    return { record, events: [] };
  }
  let reports = record.invite_reports;
  for (const inviteId of swept.expired) {
    reports = resolveReport(reports, inviteId, "expired", now);
  }
  return {
    record: {
      ...record,
      authority: spent.state,
      invite_reports: withoutReports(reports, spent.removed),
    },
    events: swept.expired.map((ref) => ({
      type: "notify_owners" as const,
      event: "redemption_resolved" as const,
      ref,
    })),
  };
}

// Drops the reports of deleted invites.
function withoutReports(
  reports: StoredClaw["invite_reports"],
  inviteIds: readonly string[],
): StoredClaw["invite_reports"] {
  if (!reports || inviteIds.length === 0) {
    return reports;
  }
  const gone = new Set(inviteIds);
  return Object.fromEntries(Object.entries(reports).filter(([inviteId]) => !gone.has(inviteId)));
}

// Marks how an invite ended in its report (kept for display).
export function resolveReport(
  reports: StoredClaw["invite_reports"],
  inviteId: string,
  resolution: NonNullable<InviteReport["resolution"]>,
  now: number,
): StoredClaw["invite_reports"] {
  const report = reports?.[inviteId] ?? { email: null, display_name: null, location_hint: null };
  return { ...reports, [inviteId]: { ...report, resolution, resolved_at: now } };
}

// The invite an accepted MembershipChange approved or denied, if any.
export function resolvedInvite(
  input: unknown,
): { inviteId: string; resolution: "approved" | "denied" } | undefined {
  const parsed = parseStatement(input, "MembershipChange");
  if (!parsed.ok) {
    return undefined;
  }
  const target = parsed.statement.body.target;
  if (target.op === "add" && target.invite_id) {
    return { inviteId: target.invite_id, resolution: "approved" };
  }
  return target.op === "deny_invite"
    ? { inviteId: target.invite_id, resolution: "denied" }
    : undefined;
}
