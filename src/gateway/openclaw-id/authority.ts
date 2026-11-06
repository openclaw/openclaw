import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
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
  recordSeen,
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
  parseStatement,
  registerInvite,
  ROOT_EPOCH,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { verifyBinding } from "./binding-check.js";
import {
  needsAllowlistUpgrade,
  upgradeNodeCollections,
  upgradeToAllowlist,
} from "./claw-migration.js";
import {
  assertSameClawIdentity,
  assertStoredClawText,
  clawStoreRows,
  readStoredClaw,
  writeStoredClaw,
  storedOwnerProfile,
  type InviteReport,
  type OpenClawIdAccount,
  type StoredClaw,
} from "./claw-store.js";
import { nextPeopleExpiry } from "./invite-expiry.js";
import { withSweptInvites, resolveReport, resolvedInvite } from "./invite-sweep.js";
import { listInviteViews } from "./invites-view.js";
import {
  canonicalMemberProfiles,
  retainMemberProfiles,
  type OpenClawIdMemberProfiles,
} from "./member-profiles.js";
import { createNodeInviteOperations, listNodeInviteViews } from "./node-invites.js";
import type { OwnerDeviceView } from "./owner-devices-view.js";
import type { OpenClawIdTunnelPrincipal } from "./tunnel-principal.js";

/** What the local link ceremony signs for: the claw's identity and keys. */
export type LinkPreparation = {
  claw_id: string;
  hostname: string;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: 1;
  root_epoch: typeof ROOT_EPOCH;
};

/** The owner-signed result of the local link ceremony. */
export type LinkCommit = {
  root_pub: Ed25519PublicKey;
  /** MembershipChange { op: add_owner_device, cert: OwnerDeviceCert(D1) }, seq 1, signed by R. */
  owner_device: unknown;
  /** ServerBinding(seq 1), signed by R. */
  binding: unknown;
};

/** A refused write: a stable code the UI matches, and detail for logs. */
export type AuthorityRefusal = {
  ok: false;
  code: string;
  detail: string;
};

/** Accepted write and the effects to perform. */
export type AuthorityAccepted = {
  ok: true;
  status: "applied" | "pending";
  events: AuthorityEvent[];
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Who sent a mailbox redemption, as asserted by OpenClaw ID. */
export type RedemptionSender = {
  account_id: string;
  email: string | null;
  display_name?: string | null;
  location_hint?: string | null;
};

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

/** A tunnel-issued device token and the device key it is bound to. */
export type DeviceTokenRef = { deviceId: string; role: string; peerKey: string };

/** Creates the authority owner over the persisted claw record. */
export function createOpenClawIdAuthority(
  store: {
    read: () => Promise<StoredClaw | undefined>;
    write: (record: StoredClaw) => Promise<void>;
    profiles?: OpenClawIdMemberProfiles;
  } = {
    read: readStoredClaw,
    write: writeStoredClaw,
  },
) {
  const profiles = store.profiles ?? canonicalMemberProfiles;
  let record: StoredClaw | undefined;
  let loading: Promise<StoredClaw | undefined> | undefined;
  let writeFailure: Error | undefined;
  const peopleListeners = new Set<() => void>();
  // Writes run one at a time so each sees the state the previous one committed.
  let queue: Promise<unknown> = Promise.resolve();

  // Complete local storage upgrades before publishing the loaded record or token bindings.
  const readInitial = async (): Promise<void> => {
    const stored = await store.read();
    if (!stored) {
      return;
    }
    let current = needsAllowlistUpgrade(stored)
      ? await upgradeToAllowlist(stored, nowSeconds())
      : stored;
    current = upgradeNodeCollections(current);
    if (
      Object.keys(current.authority?.members ?? {}).some(
        (id) => !Object.hasOwn(current.member_approved_at ?? {}, id),
      )
    ) {
      current = await retainMemberProfiles(stored, current, profiles);
    }
    if (current !== stored) {
      await store.write(current);
    }
    record = current;
  };

  // Check the live failure cell after awaits instead of retaining a narrowed pre-await value.
  const assertReadable = () => {
    if (writeFailure) {
      throw writeFailure;
    }
  };

  // Loads the record once. Every caller shares the first read, so a second, later
  // read can never replace a change committed after the first one.
  const load = async (): Promise<StoredClaw | undefined> => {
    assertReadable();
    loading ??= readInitial().then(
      () => record,
      (error: unknown) => {
        // A failed read is retried by the next caller.
        loading = undefined;
        throw error;
      },
    );
    await loading;
    assertReadable();
    return record;
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  const commit = async (candidate: StoredClaw) => {
    const next = await retainMemberProfiles(record, candidate, profiles);
    const previous = record;
    try {
      await store.write(next);
    } catch (error) {
      // A rejected acknowledgement can follow a durable commit. Withdraw cached authority
      // before reconciliation; no synchronous admission or later write may use a stale row.
      writeFailure = new Error(
        "OpenClaw ID storage outcome is uncertain; restart to reload authority",
        { cause: error },
      );
      record = undefined;
      notifyListeners(peopleListeners, undefined);
      let stored: StoredClaw | undefined;
      try {
        stored = await store.read();
      } catch {
        throw writeFailure;
      }
      if (!stored || !isDeepStrictEqual(clawStoreRows(stored), clawStoreRows(next))) {
        if (
          isDeepStrictEqual(stored && clawStoreRows(stored), previous && clawStoreRows(previous))
        ) {
          record = previous;
          writeFailure = undefined;
        }
        throw error;
      }
      // One coherent read confirmed this exact postimage. Continue its effects once, no replay.
      writeFailure = undefined;
    }
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

  // Who the tunnel device `peerKey` is in the record already loaded, synchronously.
  const currentPeer = (peerKey: string): OpenClawIdTunnelPrincipal | undefined => {
    if (!isIrohEndpointKey(peerKey)) {
      return undefined;
    }
    const state = record?.authority;
    const now = nowSeconds();
    if (!state || !isAdmitted(state, peerKey, now)) {
      return undefined;
    }
    const owner = Object.entries(state.owner_devices).find(
      ([, device]) =>
        isOwnerDeviceActive(device, now) && device.cert.body.peer_keys.includes(peerKey),
    );
    const source = { clawId: state.claw_id, rootPub: state.anchor.root_pub };
    const node = state.nodes[peerKey];
    if (node) {
      return {
        kind: "node",
        peerKey,
        authority: { ...source, listedSeq: node.listed_seq },
      };
    }
    if (owner) {
      return {
        kind: "owner",
        peerKey,
        authority: {
          ...source,
          ownerDevice: owner[0],
          listedSeq: owner[1].peer_listed_seq?.[owner[1].cert.body.peer_keys.indexOf(peerKey)] ?? 0,
        },
      };
    }
    const member = Object.entries(state.members).find(([, entry]) =>
      entry.peer_keys.includes(peerKey),
    );
    return member
      ? {
          kind: "member",
          peerKey,
          accountId: member[0],
          role: member[1].role,
          authority: {
            ...source,
            listedSeq: member[1].listed_seq?.[member[1].peer_keys.indexOf(peerKey)] ?? 0,
          },
        }
      : undefined;
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

    /** Reads member display from the canonical profile owner, never as access authority. */
    memberProfiles: profiles.read,

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
          root_epoch: ROOT_EPOCH,
        };
      });
    },

    /**
     * Pins R for good, admits owner device D1 and stores the ServerBinding.
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
          { ...expected, bindingSeq: 1 },
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

    /** Applies an owner-signed statement that arrived on `channel`. */
    submit(input: unknown, channel: Channel): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const stored = await load();
        if (!stored?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const now = nowSeconds();
        // Expired redemptions are consumed first, so a late approval cannot admit anyone.
        const { record: current, events: expiry } = withSweptInvites(
          { ...stored, authority: stored.authority },
          now,
        );
        const result = await submitStatement(current.authority, input, { channel, now });
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
        const { record: current, events } = withSweptInvites(
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

    ...createNodeInviteOperations({ serialize, load, commit }),

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
        const { record: current, events } = withSweptInvites(
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
        const display = (value: string | null | undefined) =>
          value ? truncateUtf16Safe(value.trim(), 256) : null;
        const report: InviteReport = {
          account_id: sender.account_id,
          email: display(sender.email),
          display_name: display(sender.display_name),
          location_hint: display(sender.location_hint),
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
      assertReadable();
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

    /** The tunnel-issued tokens bound to these device keys (from memory; load first). */
    tokensBoundTo(peerKeys: readonly string[]): DeviceTokenRef[] {
      return (record?.token_bindings ?? [])
        .filter((binding) => peerKeys.includes(binding.peer_key))
        .map((binding) => ({
          deviceId: binding.device_id,
          role: binding.role,
          peerKey: binding.peer_key,
        }));
    },

    /**
     * Tokens still bound to a device key that is no longer in the membership:
     * removals whose revocation did not finish. The binding keeps refusing them
     * meanwhile.
     */
    async orphanedTokens(): Promise<DeviceTokenRef[]> {
      const current = await load();
      const members = new Set<string>(current?.authority ? memberKeys(current.authority) : []);
      return (current?.token_bindings ?? [])
        .filter((binding) => !members.has(binding.peer_key))
        .map((binding) => ({
          deviceId: binding.device_id,
          role: binding.role,
          peerKey: binding.peer_key,
        }));
    },

    /** Drops the bindings of tokens whose revocation was confirmed. */
    unbindTokens(tokens: readonly DeviceTokenRef[]): Promise<void> {
      return serialize(async () => {
        const current = await load();
        const confirmed = (binding: { device_id: string; role: string; peer_key: string }) =>
          tokens.some(
            (token) =>
              token.deviceId === binding.device_id &&
              token.role === binding.role &&
              token.peerKey === binding.peer_key,
          );
        if (current && (current.token_bindings ?? []).some(confirmed)) {
          await commit({
            ...current,
            token_bindings: (current.token_bindings ?? []).filter((binding) => !confirmed(binding)),
          });
        }
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
      const nodeInvites = await listNodeInviteViews(current, nowSeconds());
      // Hashing comparison codes may yield; disclose only the same committed owner view.
      if (record !== current) {
        return undefined;
      }
      const now = nowSeconds();
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
        members: Object.entries(state.members).map(([account_id, member]) => ({
          account_id,
          role: member.role,
          peer_keys: member.peer_keys,
        })),
        invites: listInviteViews(current, now),
        nodes: Object.entries(state.nodes).map(([peer_key, node]) =>
          Object.assign({ peer_key }, node),
        ),
        node_invites: nodeInvites,
      };
    },

    /**
     * Who the tunnel device `peerKey` is right now: an active owner device, a
     * member with their role, a node-only key, or undefined when not admitted.
     * An owner device that is also listed as a member is the owner.
     */
    async resolvePeer(peerKey: string): Promise<OpenClawIdTunnelPrincipal | undefined> {
      await load();
      return currentPeer(peerKey);
    },

    /** resolvePeer against the record already loaded, synchronously; undefined before a load. */
    currentPeer,

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

    /** Durable pairing provenance compares the original listing, independently of Labs. */
    isCurrentNodeListing(source: {
      peerKey: string;
      authority: NonNullable<OpenClawIdTunnelPrincipal["authority"]>;
    }): boolean {
      const current = currentPeer(source.peerKey);
      return (
        current?.kind === "node" &&
        current.authority?.clawId === source.authority.clawId &&
        current.authority.rootPub === source.authority.rootPub &&
        current.authority.listedSeq === source.authority.listedSeq
      );
    },

    /** Peer keys the tunnel child may admit now (nodes, members and active owner devices). */
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
        if (!isOwnerDeviceActive(device, now)) {
          device.cert.body.peer_keys.forEach((key) => expired.add(key));
        }
      }
      return [...expired].filter((key) => !isAdmitted(state, key, now)).toSorted();
    },

    /** Records mirror progress; recovery may require the same committed binding through settlement. */
    recordDiscovery(update: Partial<StoredClaw["discovery"]>, expected?: StoredClaw) {
      return serialize(async () => {
        for (const field of ["owner_account_id", "mailbox_cursor"] as const) {
          if (Object.hasOwn(update, field)) {
            assertStoredClawText(update[field], field);
          }
        }
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

// Every listed node, member or owner device key, admitted now or not.
function memberKeys(state: AuthorityState): Set<IrohEndpointKey> {
  return new Set<IrohEndpointKey>([
    ...Object.values(state.members).flatMap((member) => member.peer_keys),
    ...Object.values(state.owner_devices).flatMap((record) => record.cert.body.peer_keys),
    ...Object.keys(state.nodes).filter(isIrohEndpointKey),
  ]);
}

// Every candidate key that passes the protocol's admission rule at `now`.
function listAdmitted(state: AuthorityState, now: number): IrohEndpointKey[] {
  return [...memberKeys(state)].filter((key) => isAdmitted(state, key, now)).toSorted();
}
