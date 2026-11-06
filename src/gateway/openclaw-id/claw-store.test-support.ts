// Protocol-capacity fixture, shared by serialized-size and real-persistence regression tests.
import {
  MAX_INVITES,
  MAX_MEMBER_PEER_KEYS,
  MAX_MEMBERS,
  MAX_OWNER_DEVICE_PEER_KEYS,
  MAX_OWNER_DEVICES,
  OWNER_CAPABILITIES,
  type AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";

const TEXT = "\u0001".repeat(256);
export const NOW = 1_800_000_000;
const SEQ = Number.MAX_SAFE_INTEGER;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const ed = (n: number) => `ed25519:${hex(n)}` as const;
const iroh = (n: number) => `iroh:${hex(n)}` as const;
const fp = (n: number) => `fp:${hex(n)}` as const;
export const id = (n: number) => n.toString(16).padStart(32, "0");
const sig = "A".repeat(86);
const caps = [...OWNER_CAPABILITIES];

/** A conservative full-capacity claw with a token binding for every peer key. */
export function fullClaw(text = TEXT): StoredClaw {
  const authority: AuthorityState = {
    claw_id: id(1),
    anchor: { root_pub: ed(1) },
    seq: SEQ,
    owner_devices: {},
    members: {},
    invites: {},
  };
  const peers: string[] = [];
  for (let d = 0; d < MAX_OWNER_DEVICES; d += 1) {
    const keys = Array.from({ length: MAX_OWNER_DEVICE_PEER_KEYS }, (_, k) => iroh(d * 100 + k));
    peers.push(...keys);
    const body = { device_pub: ed(d), peer_keys: keys, label: text, scope: "owner" as const };
    authority.owner_devices[fp(d)] = {
      cert: {
        v: 1,
        type: "OwnerDeviceCert",
        signer: ed(0),
        alg: "ed25519",
        sig,
        body: { ...body, caps, issued_at: NOW, expires_at: NOW, root_epoch: 1 },
      },
      caps,
      approved_by: fp(0),
      last_seen: NOW,
      listed_seq: SEQ,
      peer_listed_seq: keys.map(() => SEQ),
    };
  }
  for (let m = 0; m < MAX_MEMBERS; m += 1) {
    const keys = Array.from({ length: MAX_MEMBER_PEER_KEYS }, (_, k) => iroh(1e6 + m * 100 + k));
    peers.push(...keys);
    authority.members[`${text.slice(4)}${m.toString().padStart(4, "0")}`] = {
      role: "operator",
      peer_keys: keys,
      listed_seq: keys.map(() => SEQ),
      last_seen: Object.fromEntries(keys.map((key) => [key, NOW])),
    };
  }
  const reports: NonNullable<StoredClaw["invite_reports"]> = {};
  for (let i = 0; i < MAX_INVITES; i += 1) {
    authority.invites[id(i)] = {
      cap: {
        claw_id: id(1),
        invite_id: id(i),
        role: "operator",
        label: text,
        audience: { kind: "email", value: text },
        created_at: NOW,
        expires_at: NOW,
        single_use: true,
        secret_hash: hex(i),
      },
      status: "pending",
      proof_key: hex(i),
      created_by: fp(0),
      pending: { account_id: text, device_pub: ed(i), peer_key: iroh(i), requested_at: NOW },
    };
    reports[id(i)] = {
      account_id: text,
      email: text,
      display_name: text,
      location_hint: text,
      resolution: "approved",
      resolved_at: NOW,
    };
  }
  const bindingBody = { claw_id: id(1), hostname: text, k_srv: iroh(0), k_gw: ed(0) };
  return {
    v: 1,
    claw_id: id(1),
    hostname: text,
    authority,
    invite_reports: reports,
    member_approved_at: Object.fromEntries(
      Object.keys(authority.members).map((accountId) => [accountId, NOW]),
    ),
    owner_profile: { sub: text, email: text, name: text },
    binding: {
      v: 1,
      type: "ServerBinding",
      signer: ed(1),
      alg: "ed25519",
      sig,
      body: { ...bindingBody, binding_seq: SEQ, root_epoch: 1, issued_at: NOW },
    },
    token_bindings: peers.map((peer, n) => {
      return { device_id: hex(n), role: "operator", peer_key: peer, bound_at: NOW };
    }),
    discovery: {
      owner_account_id: text,
      published_binding_seq: SEQ,
      published_snapshot_seq: SEQ,
      publish_pending: true,
      published_snapshot_at: NOW,
      mailbox_cursor: text,
    },
  };
}
