// Pending invite redemptions expire after seven days without an owner decision
// (spec section 6.3). The protocol's reference authority does not model time
// passing, so the Gateway sweeps expired redemptions before every write and
// derives the same answer when it only reads.
import {
  PENDING_REDEMPTION_TTL_SECONDS,
  nextOwnerExpiry,
  type AuthorityState,
  type InviteRecord,
  type NodeInviteRecord,
  type UnixSeconds,
} from "../../../packages/openclaw-id-protocol/src/index.js";

/** True when a pending redemption has waited longer than the pending window. */
export function isPendingExpired(
  invite: InviteRecord | NodeInviteRecord,
  now: UnixSeconds,
): boolean {
  return (
    invite.status === "pending" &&
    invite.pending !== null &&
    invite.pending.requested_at + PENDING_REDEMPTION_TTL_SECONDS <= now
  );
}

/**
 * Consumes every expired pending redemption. The invite is used up and nothing
 * is admitted, exactly as if an owner had denied it. Returns the expired ids.
 */
export function expirePendingRedemptions(
  state: AuthorityState,
  now: UnixSeconds,
): { state: AuthorityState; expired: string[] } {
  const expired = [...Object.entries(state.invites), ...Object.entries(state.node_invites)]
    .filter(([, invite]) => isPendingExpired(invite, now))
    .map(([inviteId]) => inviteId);
  if (expired.length === 0) {
    return { state, expired };
  }
  const invites = { ...state.invites };
  const node_invites = { ...state.node_invites };
  for (const inviteId of expired) {
    if (Object.hasOwn(invites, inviteId)) {
      invites[inviteId] = { ...invites[inviteId]!, status: "consumed", pending: null };
    } else {
      node_invites[inviteId] = { ...node_invites[inviteId]!, status: "consumed", pending: null };
    }
  }
  return { state: { ...state, invites, node_invites }, expired };
}

/** Next visible invite deadline; a one-shot timer, never a polling interval. */
function nextInviteExpiry(
  state: AuthorityState | null | undefined,
  now: number,
): number | undefined {
  const deadlines = [
    ...Object.values(state?.invites ?? {}),
    ...Object.values(state?.node_invites ?? {}),
  ].flatMap((invite) => {
    const deadline =
      invite.status === "pending" && invite.pending
        ? invite.pending.requested_at + PENDING_REDEMPTION_TTL_SECONDS
        : invite.status === "open"
          ? invite.cap.expires_at
          : undefined;
    return deadline !== undefined && deadline > now ? [deadline] : [];
  });
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

/** Earliest visible invite or owner-device expiry in the loaded authority. */
export function nextPeopleExpiry(
  state: AuthorityState | null | undefined,
  now: number,
): number | undefined {
  const deadlines = [
    nextInviteExpiry(state, now),
    state ? nextOwnerExpiry(state, now) : undefined,
  ].filter((value): value is number => value !== undefined && value !== null);
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}
