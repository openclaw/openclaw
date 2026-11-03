// The Gateway's OpenClaw ID membership authority (spec sections 4 and 7). It
// owns the claw record: it loads it once, applies writes with the protocol's
// reference rules, writes through to SQLite and reports the side effects the
// Gateway must perform. Discovery is never consulted for any decision here.
import {
  activeOwnerDevices,
  DEFAULT_INACTIVITY_WINDOWS,
  dropInactive,
  isAdmitted,
  isIrohEndpointKey,
  isOwnerDeviceActive,
  linkClaw,
  nextInactivityDrop,
  nextOwnerExpiry,
  nextRootEpoch,
  recordSeen,
  regenerateOwnerKey as regenerateOwnerKeyState,
  randomBytes,
  bytesToHex,
  submitRedemption,
  submitStatement,
  type AuthorityEvent,
  type AuthorityState,
  type Channel,
  type Ed25519PublicKey,
  type InactivityWindows,
  type IrohEndpointKey,
  type KeyFingerprint,
  parseStatement,
  registerInvite,
  type OwnerCapability,
  type OwnerKeyRegenerationPreparation,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import type { OpenClawIdAccount } from "./account-sign-in.js";
import { verifyBinding } from "./binding-check.js";
import { needsAllowlistUpgrade, upgradeToAllowlist } from "./claw-migration.js";
import {
  assertSameClawIdentity,
  readStoredClaw,
  writeStoredClaw,
  storedOwnerProfile,
  type InviteReport,
  type StoredClaw,
} from "./claw-store.js";
import { expirePendingRedemptions, nextPeopleExpiry } from "./invite-expiry.js";
import { listInviteViews } from "./invites-view.js";
import type { OpenClawIdTunnelPrincipal } from "./tunnel-principal.js";

/** What the local link ceremony signs for: the claw's identity and keys. */
export type LinkPreparation = {
  claw_id: string;
  hostname: string;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: 1;
  root_epoch: 1;
};

/** The owner-signed result of the local link ceremony. */
export type LinkCommit = {
  root_pub: Ed25519PublicKey;
  /** MembershipChange { op: add_owner_device, cert: OwnerDeviceCert(D1) }, seq 1, signed by R. */
  owner_device: unknown;
  /** ServerBinding(seq 1, epoch 1), signed by R. */
  binding: unknown;
};

/** The regenerating device's result: new root R', its own enrollment and the new binding. */
export type OwnerKeyRegeneration = {
  root_pub: Ed25519PublicKey;
  /** MembershipChange { op: add_owner_device } at the next seq, signed by R' alone. */
  owner_device: unknown;
  /** ServerBinding(binding_seq + 1, new epoch) for the same claw and keys, signed by R'. */
  binding: unknown;
};

// True for a statement that parses as a RootRotation.
function isRootRotation(input: unknown): boolean {
  return parseStatement(input, "RootRotation").ok;
}

/**
 * A refused write: a stable code the UI matches, and detail for logs. `events` are
 * side effects the refusal itself requires (the conflicting-rotation owner alert);
 * the state change behind them is already committed.
 */
export type AuthorityRefusal = {
  ok: false;
  code: string;
  detail: string;
  events?: AuthorityEvent[];
};

/** Accepted write and the effects to perform. */
export type AuthorityAccepted = {
  ok: true;
  status: "applied" | "pending";
  events: AuthorityEvent[];
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const regenerationNeedsLoopback =
  "owner-key regeneration needs direct loopback on the running Gateway";

/** Who sent a mailbox redemption, as asserted by OpenClaw ID. */
export type RedemptionSender = {
  account_id: string;
  email: string | null;
  display_name?: string | null;
  location_hint?: string | null;
};

// Consumes expired pending redemptions before a write sees the state, and
// records them as expired. Returns the record to write from and the owner notices.
function withExpiredRedemptions(
  record: StoredClaw & { authority: NonNullable<StoredClaw["authority"]> },
  now: number,
): {
  record: StoredClaw & { authority: NonNullable<StoredClaw["authority"]> };
  events: AuthorityEvent[];
} {
  const swept = expirePendingRedemptions(record.authority, now);
  if (swept.expired.length === 0) {
    return { record, events: [] };
  }
  let reports = record.invite_reports;
  for (const inviteId of swept.expired) {
    reports = resolveReport(reports, inviteId, "expired", now);
  }
  return {
    record: { ...record, authority: swept.state, invite_reports: reports },
    events: swept.expired.map((ref) => ({
      type: "notify_owners" as const,
      event: "redemption_resolved" as const,
      ref,
    })),
  };
}

// Marks how an invite ended in its report (kept for display).
function resolveReport(
  reports: StoredClaw["invite_reports"],
  inviteId: string,
  resolution: NonNullable<InviteReport["resolution"]>,
  now: number,
): StoredClaw["invite_reports"] {
  const report = reports?.[inviteId] ?? { email: null, display_name: null, location_hint: null };
  return { ...reports, [inviteId]: { ...report, resolution, resolved_at: now } };
}

// The invite an accepted MembershipChange approved or denied, if any.
function resolvedInvite(
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

function emptyRecord(clawId: string): StoredClaw {
  return {
    v: 1,
    claw_id: clawId,
    hostname: null,
    authority: null,
    binding: null,
    discovery: {
      owner_account_id: null,
      published_binding_seq: 0,
      published_snapshot_seq: 0,
      mailbox_cursor: null,
    },
  };
}

/** An owner device as the owner's own devices see it: certificate, granted caps and approver. */
export type OwnerDeviceView = {
  cert: SignedStatement<"OwnerDeviceCert">;
  caps: OwnerCapability[];
  approved_by: "root" | KeyFingerprint;
};

/** Creates the authority owner over the persisted claw record. */
export function createOpenClawIdAuthority(
  store: {
    read: () => Promise<StoredClaw | undefined>;
    write: (record: StoredClaw) => Promise<void>;
  } = {
    read: readStoredClaw,
    write: writeStoredClaw,
  },
) {
  let record: StoredClaw | undefined;
  let loaded = false;
  const peopleListeners = new Set<() => void>();
  // Writes run one at a time so each sees the state the previous one committed.
  let queue: Promise<unknown> = Promise.resolve();

  // Loads the record once; a pre-allowlist record is upgraded and written back first.
  const load = async (): Promise<StoredClaw | undefined> => {
    if (!loaded) {
      const stored = await store.read();
      if (stored && needsAllowlistUpgrade(stored)) {
        const upgraded = await upgradeToAllowlist(stored, nowSeconds());
        await store.write(upgraded);
        record = upgraded;
      } else {
        record = stored;
      }
      loaded = true;
    }
    return record;
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  const commit = async (next: StoredClaw) => {
    await store.write(next);
    const previous = record;
    record = next;
    // Publish only committed People/display facts, before any network side effects.
    if (
      previous?.authority !== next.authority ||
      previous?.invite_reports !== next.invite_reports ||
      previous?.owner_profile !== next.owner_profile ||
      previous?.discovery.owner_account_id !== next.discovery.owner_account_id
    ) {
      notifyListeners(peopleListeners, undefined);
    }
  };

  return {
    /** Loads the record (once); call before reading state synchronously. */
    load,

    /** Observes committed membership and account display changes from every writer. */
    onPeopleChanged: (listener: () => void): (() => void) =>
      registerListener(peopleListeners, listener),

    /** Persists only a server-verified sign-in; another subject cannot replace a linked owner. */
    recordVerifiedAccount(account: OpenClawIdAccount): Promise<void> {
      return serialize(async () => {
        const current = (await load()) ?? emptyRecord(bytesToHex(randomBytes(16)));
        const owner = current.discovery.owner_account_id;
        if (owner && owner !== account.sub) {
          return;
        }
        await commit({ ...current, owner_profile: storedOwnerProfile(account) });
      });
    },

    /** Prepares key hashing once, then checks the current authority synchronously at disclosure. */
    async prepareOwnerPeerCheck(peerKey: string): Promise<() => boolean> {
      if (!isIrohEndpointKey(peerKey)) {
        return () => false;
      }
      await load();
      return () => {
        const state = record?.authority;
        return Boolean(
          state &&
          activeOwnerDevices(state, nowSeconds()).some((device) =>
            device.cert.body.peer_keys.includes(peerKey),
          ),
        );
      };
    },

    /** The current record, if loaded. */
    current(): StoredClaw | undefined {
      return record;
    },

    /**
     * Ensures a claw id exists, records the hostname Discovery assigned for the owner's chosen
     * name and returns the values the link ceremony signs.
     */
    prepareLink(params: {
      kSrv: IrohEndpointKey;
      kGw: Ed25519PublicKey;
      hostname: string;
    }): Promise<LinkPreparation | AuthorityRefusal> {
      return serialize(async () => {
        const current = await load();
        if (current?.authority) {
          return { ok: false, code: "already_linked", detail: "this claw is already linked" };
        }
        const next = current ?? emptyRecord(bytesToHex(randomBytes(16)));
        const hostname = params.hostname;
        if (next !== current || next.hostname !== hostname) {
          await commit({ ...next, hostname });
        }
        return {
          claw_id: next.claw_id,
          hostname,
          k_srv: params.kSrv,
          k_gw: params.kGw,
          binding_seq: 1,
          root_epoch: 1,
        };
      });
    },

    /**
     * Pins fp(R) at epoch 1, admits owner device D1 and stores the ServerBinding.
     * Only over direct loopback: relayed traffic never runs a root ceremony.
     */
    commitLink(
      input: LinkCommit,
      channel: Channel | undefined,
      expected: { kSrv: IrohEndpointKey; kGw: Ed25519PublicKey },
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return { ok: false, code: "not_local_operator", detail: "linking needs direct loopback" };
        }
        const current = await load();
        if (!current?.hostname) {
          return { ok: false, code: "not_prepared", detail: "prepare the link first" };
        }
        if (current.authority) {
          return { ok: false, code: "already_linked", detail: "this claw is already linked" };
        }
        const linked = linkClaw({ claw_id: current.claw_id, root_pub: input.root_pub }, channel);
        if (!linked.ok) {
          return { ok: false, code: linked.code, detail: "linking needs direct loopback" };
        }
        const now = nowSeconds();
        const added = await submitStatement(linked.state, input.owner_device, { channel, now });
        if (!added.ok) {
          return { ok: false, code: added.code, detail: added.detail };
        }
        const binding = await verifyBinding(
          added.state,
          input.binding,
          current,
          { ...expected, bindingSeq: 1, rootEpoch: 1 },
          now,
        );
        if (!binding.ok) {
          return binding;
        }
        await commit({ ...current, authority: added.state, binding: binding.statement });
        return {
          ok: true,
          status: "applied",
          events: [...added.events, { type: "publish_snapshot" }],
        };
      });
    },

    /**
     * What the regenerating device signs for: the claw's current keys, the next
     * binding seq, the new root epoch and the seq of its own enrollment. Direct loopback only.
     */
    prepareRegeneration(
      channel: Channel | undefined,
    ): Promise<OwnerKeyRegenerationPreparation | AuthorityRefusal> {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return { ok: false, code: "not_local_operator", detail: regenerationNeedsLoopback };
        }
        const current = await load();
        if (!current?.authority || !current.binding) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const binding = current.binding.body;
        return {
          claw_id: current.claw_id,
          hostname: binding.hostname,
          k_srv: binding.k_srv,
          k_gw: binding.k_gw,
          binding_seq: binding.binding_seq + 1,
          root_epoch: nextRootEpoch(current.authority),
          seq: current.authority.seq + 1,
        };
      });
    },

    /**
     * Regenerates the owner key: pins R' in a new epoch (clearing a freeze), drops
     * every older owner certificate, enrolls the regenerating device and stores the
     * new binding. The events end the old devices' sessions and tokens and republish.
     * Only over direct loopback: relayed traffic can never regenerate the owner key.
     */
    regenerateOwnerKey(
      input: OwnerKeyRegeneration,
      channel: Channel | undefined,
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return { ok: false, code: "not_local_operator", detail: regenerationNeedsLoopback };
        }
        const current = await load();
        if (!current?.authority || !current.binding) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const now = nowSeconds();
        const result = await regenerateOwnerKeyState(
          current.authority,
          { root_pub: input.root_pub, owner_device: input.owner_device },
          { channel, now },
        );
        if (!result.ok) {
          return { ok: false, code: result.code, detail: result.detail };
        }
        const previous = current.binding.body;
        const binding = await verifyBinding(
          result.state,
          input.binding,
          current,
          {
            kSrv: previous.k_srv,
            kGw: previous.k_gw,
            bindingSeq: previous.binding_seq + 1,
            rootEpoch: result.state.anchor.root_epoch,
          },
          now,
        );
        if (!binding.ok) {
          return binding;
        }
        await commit({ ...current, authority: result.state, binding: binding.statement });
        return { ok: true, status: "applied", events: result.events };
      });
    },

    /** Applies an owner-signed statement that arrived on `channel`. */
    submit(input: unknown, channel: Channel): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const stored = await load();
        if (!stored?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        // On direct loopback the owner key is regenerated, never rotated by statement:
        // a rotation alone would leave the binding signed by the old root. Remote
        // rotations still reach the protocol rules, which refuse them and detect conflicts.
        if (channel === "local_operator" && isRootRotation(input)) {
          return {
            ok: false,
            code: "unsupported",
            detail: "regenerate the owner key instead of submitting a RootRotation",
          };
        }
        const now = nowSeconds();
        // Expired redemptions are consumed first, so a late approval cannot admit anyone.
        const { record: current, events: expiry } = withExpiredRedemptions(
          { ...stored, authority: stored.authority },
          now,
        );
        const result = await submitStatement(current.authority, input, { channel, now });
        if (!result.ok && result.persist) {
          // A refusal with a security transition (the conflict freeze) still commits it.
          await commit({ ...current, authority: result.state });
          return {
            ok: false,
            code: result.code,
            detail: result.detail,
            events: [...expiry, ...result.events],
          };
        }
        if (!result.ok) {
          if (expiry.length > 0) {
            await commit(current);
          }
          return { ok: false, code: result.code, detail: result.detail };
        }
        const resolved = resolvedInvite(input);
        await commit({
          ...current,
          authority: result.state,
          ...(resolved
            ? {
                invite_reports: resolveReport(
                  current.invite_reports,
                  resolved.inviteId,
                  resolved.resolution,
                  now,
                ),
              }
            : {}),
        });
        const reconnect = roleChangeDisconnects(current.authority, result.state);
        return {
          ok: true,
          status: result.status,
          events: [...expiry, ...result.events, ...reconnect],
        };
      });
    },

    /**
     * Registers an owner-signed InviteCap and its proof key, sent directly by an
     * owner device (tunnel or loopback, never the mailbox).
     */
    registerInvite(
      input: { cap: unknown; proofKey: Uint8Array },
      channel: Channel,
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const stored = await load();
        if (!stored?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const now = nowSeconds();
        const { record: current, events } = withExpiredRedemptions(
          { ...stored, authority: stored.authority },
          now,
        );
        const result = await registerInvite(current.authority, input.cap, input.proofKey, {
          channel,
          now,
        });
        if (!result.ok) {
          if (events.length > 0) {
            await commit(current);
          }
          return { ok: false, code: result.code, detail: result.detail };
        }
        await commit({ ...current, authority: result.state });
        return { ok: true, status: result.status, events: [...events, ...result.events] };
      });
    },

    /** Records an invite redemption from the mailbox as pending (it admits nothing). */
    redeem(
      input: unknown,
      sender: RedemptionSender,
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const stored = await load();
        if (!stored?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const now = nowSeconds();
        const { record: current, events } = withExpiredRedemptions(
          { ...stored, authority: stored.authority },
          now,
        );
        const identity = { account_id: sender.account_id, email: sender.email };
        const result = await submitRedemption(current.authority, input, identity, now);
        if (!result.ok) {
          if (events.length > 0) {
            await commit(current);
          }
          return { ok: false, code: result.code, detail: result.detail };
        }
        const inviteId = parseStatement(input, "InviteRedemption");
        const report: InviteReport = {
          account_id: sender.account_id,
          email: sender.email,
          display_name: sender.display_name ?? null,
          location_hint: sender.location_hint ?? null,
        };
        await commit({
          ...current,
          authority: result.state,
          invite_reports: inviteId.ok
            ? { ...current.invite_reports, [inviteId.statement.body.invite_id]: report }
            : current.invite_reports,
        });
        return { ok: true, status: result.status, events: [...events, ...result.events] };
      });
    },

    /** The device key a tunnel-issued token belongs to (from memory; load first). */
    tokenBinding(deviceId: string, role: string): string | undefined {
      return record?.token_bindings?.find(
        (binding) => binding.device_id === deviceId && binding.role === role,
      )?.peer_key;
    },

    /** Records (or replaces) the device key a token was issued to. */
    bindToken(deviceId: string, role: string, peerKey: string): Promise<void> {
      return serialize(async () => {
        const current = await load();
        if (!current) {
          return;
        }
        const others = (current.token_bindings ?? []).filter(
          (binding) => binding.device_id !== deviceId || binding.role !== role,
        );
        await commit({
          ...current,
          token_bindings: [
            ...others,
            { device_id: deviceId, role, peer_key: peerKey, bound_at: nowSeconds() },
          ],
        });
      });
    },

    /** Drops the bindings of removed device keys; returns the (device, role) tokens to revoke. */
    unbindPeers(peerKeys: readonly string[]): Promise<Array<{ deviceId: string; role: string }>> {
      return serialize(async () => {
        const current = await load();
        const removed = (current?.token_bindings ?? []).filter((binding) =>
          peerKeys.includes(binding.peer_key),
        );
        if (current && removed.length > 0) {
          await commit({
            ...current,
            token_bindings: (current.token_bindings ?? []).filter(
              (binding) => !peerKeys.includes(binding.peer_key),
            ),
          });
        }
        return removed.map((binding) => ({ deviceId: binding.device_id, role: binding.role }));
      });
    },

    /**
     * What an owner device reaching the claw over the tunnel may read: the seq to
     * sign the next change at, the binding, every active owner device with who
     * approved it, members and invites. Undefined unless `peerKey` belongs to an
     * active owner device.
     */
    async ownerView(peerKey: string) {
      const current = await load();
      const state = current?.authority;
      if (!state) {
        return undefined;
      }
      const now = nowSeconds();
      const owners = activeOwnerDevices(state, now);
      if (
        !owners.some((device) => device.cert.body.peer_keys.includes(peerKey as IrohEndpointKey))
      ) {
        return undefined;
      }
      return {
        claw_id: state.claw_id,
        seq: state.seq,
        root_pub: state.anchor.root_pub,
        root_epoch: state.anchor.root_epoch,
        binding: current.binding,
        owner_devices: owners.map((device): OwnerDeviceView => ({
          cert: device.cert,
          caps: device.caps,
          approved_by: device.approved_by,
        })),
        members: Object.entries(state.members).map(([account_id, member]) => ({
          account_id,
          role: member.role,
          peer_keys: member.peer_keys,
        })),
        invites: listInviteViews(current, now),
      };
    },

    /**
     * Who the tunnel device `peerKey` is right now: an active owner device, a
     * member with their role, or undefined when the protocol would not admit it.
     * An owner device that is also listed as a member is the owner.
     */
    async resolvePeer(peerKey: string): Promise<OpenClawIdTunnelPrincipal | undefined> {
      await load();
      if (!isIrohEndpointKey(peerKey)) {
        return undefined;
      }
      const state = record?.authority;
      const now = nowSeconds();
      if (!state || !isAdmitted(state, peerKey, now)) {
        return undefined;
      }
      const isOwner = Object.values(state.owner_devices).some(
        (device) =>
          isOwnerDeviceActive(state, device, now) && device.cert.body.peer_keys.includes(peerKey),
      );
      if (isOwner) {
        return { kind: "owner", peerKey };
      }
      const member = Object.entries(state.members).find(([, entry]) =>
        entry.peer_keys.includes(peerKey),
      );
      return member
        ? { kind: "member", peerKey, accountId: member[0], role: member[1].role }
        : undefined;
    },

    /**
     * Records that the tunnel admitted `peerKey` now (its inactivity clock restarts).
     * Writes only when `last_seen` moved past the protocol's resolution.
     */
    recordSeen(peerKey: string): Promise<void> {
      return serialize(async () => {
        const current = await load();
        if (!current?.authority || !isIrohEndpointKey(peerKey)) {
          return;
        }
        const next = recordSeen(current.authority, peerKey, nowSeconds());
        if (next) {
          await commit({ ...current, authority: next });
        }
      });
    },

    /**
     * Drops owner devices and member browsers unused for longer than the inactivity
     * windows (protocol defaults where unset). Devices a dropped owner device approved
     * stay. Returns the dropped peer keys.
     */
    dropInactive(windows: Partial<InactivityWindows> = {}): Promise<IrohEndpointKey[]> {
      return serialize(async () => {
        const current = await load();
        const dropped = current?.authority
          ? dropInactive(current.authority, nowSeconds(), withDefaults(windows))
          : null;
        if (!current || !dropped) {
          return [];
        }
        await commit({ ...current, authority: dropped.state });
        return dropped.peers;
      });
    },

    /** Peer keys the tunnel child may admit right now (members and active owner devices). */
    async admittedPeerKeys(): Promise<{ seq: number; admitted: IrohEndpointKey[] }> {
      const state = (await load())?.authority;
      if (!state) {
        return { seq: 0, admitted: [] };
      }
      return { seq: state.seq, admitted: listAdmitted(state, nowSeconds()) };
    },

    /** Next time-derived People change in the loaded record, even with the tunnel offline. */
    nextPeopleExpiry(): number | undefined {
      return nextPeopleExpiry(record?.authority, nowSeconds());
    },

    /**
     * When (unix seconds) the next owner device certificate expires or the next key
     * becomes due for the inactivity drop; undefined when neither is pending.
     */
    async nextOwnerExpiry(windows: Partial<InactivityWindows> = {}): Promise<number | undefined> {
      const state = (await load())?.authority;
      if (!state) {
        return undefined;
      }
      const due = [
        nextOwnerExpiry(state, nowSeconds()),
        nextInactivityDrop(state, withDefaults(windows)),
      ].filter((at): at is number => at !== null);
      return due.length > 0 ? Math.min(...due) : undefined;
    },

    /** Peer keys of listed owner devices no longer admitted because their certificate expired. */
    async expiredOwnerPeers(): Promise<IrohEndpointKey[]> {
      const state = (await load())?.authority;
      if (!state) {
        return [];
      }
      const now = nowSeconds();
      const expired = new Set<IrohEndpointKey>();
      for (const device of Object.values(state.owner_devices)) {
        if (
          device.cert.body.root_epoch === state.anchor.root_epoch &&
          !isOwnerDeviceActive(state, device, now)
        ) {
          device.cert.body.peer_keys.forEach((key) => expired.add(key));
        }
      }
      return [...expired].filter((key) => !isAdmitted(state, key, now)).toSorted();
    },

    /** Records mirror progress; recovery may require the same committed binding through settlement. */
    recordDiscovery(update: Partial<StoredClaw["discovery"]>, expected?: StoredClaw) {
      return serialize(async () => {
        const current = await load();
        if (expected) {
          assertSameClawIdentity(current, expected);
        }
        if (current) {
          const next = { ...current, discovery: { ...current.discovery, ...update } };
          const owner = next.discovery.owner_account_id;
          // Omit an absent or unrelated profile; explicit undefined is not valid store JSON.
          // A link code for another account must never adopt this sign-in's profile.
          if (!next.owner_profile || (owner && next.owner_profile.sub !== owner)) {
            delete next.owner_profile;
          }
          await commit(next);
        }
      });
    },
  };
}

export type OpenClawIdAuthority = ReturnType<typeof createOpenClawIdAuthority>;

// Inactivity windows with the protocol defaults filled in.
function withDefaults(windows: Partial<InactivityWindows>): InactivityWindows {
  return { ...DEFAULT_INACTIVITY_WINDOWS, ...windows };
}

// A member whose role changed reconnects, so their Gateway connections pick up the
// new role's scope ceiling instead of keeping the one granted at connect.
function roleChangeDisconnects(before: AuthorityState, after: AuthorityState): AuthorityEvent[] {
  const peerKeys = Object.entries(after.members).flatMap(([accountId, member]) => {
    const previous = before.members[accountId];
    return previous && previous.role !== member.role ? member.peer_keys : [];
  });
  return peerKeys.length > 0 ? [{ type: "disconnect", peer_keys: peerKeys }] : [];
}

// Every candidate key that passes the protocol's admission rule at `now`.
function listAdmitted(state: AuthorityState, now: number): IrohEndpointKey[] {
  const candidates = new Set<IrohEndpointKey>([
    ...Object.values(state.members).flatMap((member) => member.peer_keys),
    ...Object.values(state.owner_devices).flatMap((record) => record.cert.body.peer_keys),
  ]);
  return [...candidates].filter((key) => isAdmitted(state, key, now)).toSorted();
}
