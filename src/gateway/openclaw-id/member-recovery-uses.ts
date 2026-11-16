// Public recovery-use history is committed with admission, never with an unverified mailbox hint.
import { fingerprint } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { retainMemberProfiles, type OpenClawIdMemberProfiles } from "./member-profiles.js";

/** Owner-visible evidence; no signing material and no authority to approve another browser. */
export type MemberRecoveryUse = {
  seq: number;
  accountId: string;
  memberName: string;
  deviceLabel: string;
  peerKey: string;
  peerFp: string;
  usedAt: number;
};

/** Retains each accepted kit use even after the member, browser, or kit is removed. */
export async function retainMemberRecoveryUses(
  previous: StoredClaw | undefined,
  candidate: StoredClaw,
  profiles: OpenClawIdMemberProfiles,
): Promise<StoredClaw> {
  const next = await retainMemberProfiles(previous, candidate, profiles);
  const state = next.authority;
  if (!state) {
    return next;
  }
  const uses: MemberRecoveryUse[] = [];
  for (const [accountId, member] of Object.entries(state.members)) {
    for (const peerKey of member.peer_keys) {
      const device = member.devices?.[peerKey];
      if (
        device?.approved_by.kind !== "member_recovery_kit" ||
        previous?.authority?.members[accountId]?.peer_keys.includes(peerKey)
      ) {
        continue;
      }
      const usedAt = member.last_seen[peerKey];
      if (usedAt === undefined) {
        throw new Error("A recovered member browser must have an admission time");
      }
      const profile = (await profiles.read([accountId]))[accountId];
      uses.push({
        seq: state.seq,
        accountId,
        memberName: profile?.displayName || profile?.email || accountId,
        deviceLabel: device.label,
        peerKey,
        peerFp: await fingerprint(peerKey),
        usedAt,
      });
    }
  }
  return uses.length
    ? { ...next, member_recovery_uses: [...(next.member_recovery_uses ?? []), ...uses] }
    : next;
}
