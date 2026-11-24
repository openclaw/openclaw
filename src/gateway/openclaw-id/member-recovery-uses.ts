// Public recovery-use history is committed with admission, never with an unverified mailbox hint.
import { fingerprint } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { retainMemberProfiles, type OpenClawIdMemberProfiles } from "./member-profiles.js";
import type { MemberRecoveryUse } from "./member-recovery-use-contract.js";
import { describeMemberDevices } from "./membership-views.js";

/** Retains each accepted kit use even after the member, browser, or kit is removed. */
export async function retainMemberRecoveryUses(
  previous: StoredClaw | undefined,
  candidate: StoredClaw,
  profiles: OpenClawIdMemberProfiles,
  memberRolesEnabled: () => boolean,
): Promise<{ record: StoredClaw; assertCurrent: () => void }> {
  const retained = await retainMemberProfiles(previous, candidate, profiles, memberRolesEnabled);
  const next = retained.record;
  const state = next.authority;
  if (!state) {
    return retained;
  }
  const uses: MemberRecoveryUse[] = [];
  for (const [accountId, member] of Object.entries(state.members)) {
    const recoveredPeers = member.peer_keys.filter(
      (peerKey) =>
        member.devices?.[peerKey]?.approved_by?.kind === "member_recovery_kit" &&
        !previous?.authority?.members[accountId]?.peer_keys.includes(peerKey),
    );
    if (!recoveredPeers.length) {
      continue;
    }
    for (const device of await describeMemberDevices(member)) {
      const peerKey = device.peer_key;
      if (!recoveredPeers.includes(peerKey)) {
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
  return {
    ...retained,
    record: uses.length
      ? { ...next, member_recovery_uses: [...(next.member_recovery_uses ?? []), ...uses] }
      : next,
  };
}
