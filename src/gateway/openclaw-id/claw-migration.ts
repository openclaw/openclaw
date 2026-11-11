// One-time upgrade of a claw record written before the allowlist model. Older records
// kept certificate chains, a growing `revoked` fingerprint list and the owner-signed
// Revocations published to Discovery. The allowlist keeps current state only, so the
// upgrade drops that history, records who approved each owner device and starts every
// inactivity clock at the upgrade. Records from before granted capabilities were stored
// take each owner device's caps from its stored certificate. Records from before owner
// reset was removed (OCF-319) drop the root epoch, root history, rotations and freeze:
// a claw's root never changes now.
import {
  fingerprint,
  type AuthorityState,
  type IrohEndpointKey,
  type KeyFingerprint,
  type MemberRecord,
  type OwnerDeviceRecord,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";

// The pre-allowlist shapes this upgrade reads.
type LegacyOwnerDevice = { cert: SignedStatement<"OwnerDeviceCert">; chain_fps?: KeyFingerprint[] };
type LegacyAuthority = Omit<AuthorityState, "anchor" | "owner_devices" | "members"> & {
  anchor: AuthorityState["anchor"] & { root_epoch?: number };
  owner_devices: Record<KeyFingerprint, LegacyOwnerDevice & Partial<OwnerDeviceRecord>>;
  members: Record<string, Omit<MemberRecord, "last_seen"> & Partial<MemberRecord>>;
  revoked?: KeyFingerprint[];
  root_history?: unknown;
  rotation_seen?: unknown;
  frozen?: boolean;
};
type LegacyClaw = Omit<StoredClaw, "authority"> & {
  authority: LegacyAuthority | null;
  revocations?: unknown[];
  discovery: StoredClaw["discovery"] & { published_revocations?: number };
};

/**
 * True when `record` was written before the allowlist model, before owner devices carried
 * their granted caps, or before root epochs were removed, and must be upgraded.
 */
export function needsAllowlistUpgrade(record: StoredClaw): boolean {
  const legacy: LegacyClaw = record;
  return (
    "revocations" in legacy ||
    "published_revocations" in legacy.discovery ||
    (legacy.binding !== null && "chain" in legacy.binding) ||
    (legacy.authority !== null &&
      ("revoked" in legacy.authority ||
        "root_history" in legacy.authority ||
        "rotation_seen" in legacy.authority ||
        "frozen" in legacy.authority ||
        "root_epoch" in legacy.authority.anchor ||
        Object.values(legacy.authority.owner_devices).some(
          (device) =>
            device.approved_by === undefined || device.caps === undefined || "chain" in device.cert,
        ) ||
        Object.values(legacy.authority.members).some((member) => member.last_seen === undefined)))
  );
}

// A statement without the retired `chain` member (signatures never covered it).
function withoutChain<T extends SignedStatement>(statement: T): T {
  // SAFETY: a legacy statement may carry `chain`; reading an absent optional member is harmless.
  const { chain: _chain, ...rest } = statement as T & { chain?: unknown };
  // SAFETY: removing `chain` leaves exactly the current SignedStatement fields.
  return rest as T;
}

// Owner devices as allowlist entries. A device whose chain held a revoked key was
// already inactive; it is dropped rather than carried over.
async function upgradeOwnerDevices(
  authority: LegacyAuthority,
  now: number,
): Promise<AuthorityState["owner_devices"]> {
  const revoked = new Set(authority.revoked ?? []);
  const devices: AuthorityState["owner_devices"] = {};
  for (const [fp, device] of Object.entries(authority.owner_devices)) {
    if ((device.chain_fps ?? []).some((each) => revoked.has(each))) {
      continue;
    }
    const cert = withoutChain(device.cert);
    // SAFETY: owner_devices is keyed by KeyFingerprint; Object.entries widens keys to string.
    devices[fp as KeyFingerprint] = {
      cert,
      caps: device.caps ?? [...cert.body.caps],
      approved_by:
        device.approved_by ??
        (cert.signer === authority.anchor.root_pub ? "root" : await fingerprint(cert.signer)),
      last_seen: device.last_seen ?? now,
    };
  }
  return devices;
}

// Members with an inactivity clock for every peer key, starting now when unknown.
function upgradeMembers(authority: LegacyAuthority, now: number): AuthorityState["members"] {
  return Object.fromEntries(
    Object.entries(authority.members).map(([account, member]) => {
      const lastSeen: MemberRecord["last_seen"] = {};
      for (const key of member.peer_keys) {
        // SAFETY: member peer keys are IrohEndpointKeys; the legacy type widens them to string.
        lastSeen[key as IrohEndpointKey] = member.last_seen?.[key] ?? now;
      }
      return [account, { role: member.role, peer_keys: member.peer_keys, last_seen: lastSeen }];
    }),
  );
}

/**
 * Upgrades a legacy record. The result republishes to Discovery (a snapshot without
 * `revoked`, and a descriptor without `rotations` whose binding has no `chain`).
 */
export async function upgradeToAllowlist(record: StoredClaw, now: number): Promise<StoredClaw> {
  const legacy: LegacyClaw = record;
  const {
    revocations: _revocations,
    authority: _authority,
    binding: _binding,
    discovery: _discovery,
    ...rest
  } = legacy;
  const { published_revocations: _published, ...discovery } = legacy.discovery;
  let authority: AuthorityState | null = null;
  if (legacy.authority) {
    const {
      revoked: _revoked,
      root_history: _history,
      rotation_seen: _rotations,
      frozen: _frozen,
      ...state
    } = legacy.authority;
    authority = {
      ...state,
      anchor: { root_pub: legacy.authority.anchor.root_pub },
      owner_devices: await upgradeOwnerDevices(legacy.authority, now),
      members: upgradeMembers(legacy.authority, now),
    };
  }
  return {
    ...rest,
    authority,
    binding: legacy.binding ? withoutChain(legacy.binding) : null,
    discovery: legacy.authority ? { ...discovery, publish_pending: true } : discovery,
  };
}
