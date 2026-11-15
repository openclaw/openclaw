// Membership projections; the authority owns admission and snapshot currency.
import {
  activeOwnerDevices,
  fingerprint,
  isAdmitted,
  type IrohEndpointKey,
  type MemberRecord,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { listInviteViews } from "./invites-view.js";
import { listNodeInviteViews } from "./node-invites.js";
import type { OwnerDeviceView } from "./owner-devices-view.js";
import type { OpenClawIdTunnelPrincipal } from "./tunnel-principal.js";

/** Display metadata from listed peers; missing metadata never grants signing rights. */
export async function describeMemberDevices(member: MemberRecord) {
  return Promise.all(
    member.peer_keys.map(async (peer_key) => {
      const device = member.devices?.[peer_key];
      const deviceFp = device ? await fingerprint(device.device_pub) : null;
      const label = device?.label.trim() ?? "";
      const needsIdentity =
        !label ||
        member.peer_keys.some(
          (peer) => peer !== peer_key && member.devices?.[peer]?.label.trim() === label,
        );
      // All member-device surfaces share this display label; stored signed labels stay intact.
      const displayLabel = needsIdentity
        ? `${label || "Device"} (${(deviceFp ?? (await fingerprint(peer_key))).slice(3, 11)})`
        : label;
      return {
        peer_key,
        device_fp: deviceFp,
        label: displayLabel,
        approved_by: device?.approved_by ?? null,
        last_seen: member.last_seen[peer_key] ?? null,
      };
    }),
  );
}

/** Only the admitted member's account, without owner, invite or other-account details. */
export async function readMemberView(
  current: StoredClaw | undefined,
  principal: OpenClawIdTunnelPrincipal | undefined,
) {
  if (!current?.authority || principal?.kind !== "member") {
    return undefined;
  }
  const member = current.authority.members[principal.accountId]!;
  const devices = await describeMemberDevices(member);
  return {
    claw_id: current.claw_id,
    seq: current.authority.seq,
    binding_seq: current.binding!.body.binding_seq,
    account_id: principal.accountId,
    role: member.role,
    devices: devices.map((device) =>
      Object.assign(device, { this_device: device.peer_key === principal.peerKey }),
    ),
  };
}

/** The full membership projection, disclosed only to an active owner device. */
export async function readOwnerView(current: StoredClaw | undefined, peerKey: string) {
  const state = current?.authority;
  if (!state) {
    return undefined;
  }
  const [nodeInvites, members] = await Promise.all([
    listNodeInviteViews(current, Math.floor(Date.now() / 1000)),
    Promise.all(
      Object.entries(state.members).map(async ([account_id, member]) => ({
        account_id,
        role: member.role,
        peer_keys: member.peer_keys,
        devices: await describeMemberDevices(member),
      })),
    ),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const owners = activeOwnerDevices(state, now);
  if (
    // SAFETY: peerKey is compared by string equality only; a malformed key matches no certificate.
    !owners.some((device) => device.cert.body.peer_keys.includes(peerKey as IrohEndpointKey))
  ) {
    return undefined;
  }
  return {
    claw_id: state.claw_id,
    seq: state.seq,
    root_pub: state.anchor.root_pub,
    binding: current.binding,
    owner_devices: owners.map((device): OwnerDeviceView => ({
      cert: device.cert,
      caps: device.caps,
      approved_by: device.approved_by,
    })),
    members,
    invites: listInviteViews(current, now),
    nodes: Object.entries(state.nodes)
      // SAFETY: nodes is keyed by IrohEndpointKey; Object.entries widens keys to string.
      .filter(([key]) => isAdmitted(state, key as IrohEndpointKey, now))
      .map(([peer_key, node]) => Object.assign({ peer_key }, node)),
    node_invites: nodeInvites,
  };
}
