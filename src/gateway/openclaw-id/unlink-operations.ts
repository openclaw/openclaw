// Unlinking (enrollment.md, "Unlinking a claw"; OCF-281): the person at the machine ends the
// claw's link to OpenClaw ID for good. These operations run in the authority owner's serialized
// load/commit lane, so an unlink never interleaves with a link, re-bind or membership write.
//
// An unlink signs a ClawUnlink with the K_gw of the current binding, removes every owner device,
// member, member device, node and invite, and clears the link and binding. The claw record
// starts over under a new claw id, so linking this computer again makes a new claw. Tunnel-bound
// token bindings stay until their revocation is confirmed. The signed statement is kept as a
// pending unlink until Discovery confirms it; earlier pending unlinks are kept too. A claw no
// registration was ever sent for cannot be at Discovery: its unlink is local only, with nothing
// pending. A registration is marked sent in this lane before it is sent, so an unlink either sees
// the mark or comes first, and then the mark fails and the publication sends nothing.
import {
  bytesToHex,
  isIrohEndpointKey,
  randomBytes,
  signStatement,
  type AuthorityEvent,
  type AuthorityState,
  type Channel,
  type IrohEndpointKey,
  type SignedStatement,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import type { StoredClaw } from "./claw-store.js";

/** Who and what loses access when this claw is unlinked; shown before the owner confirms. */
export type UnlinkPreview = {
  claw_id: string;
  hostname: string;
  /** Members (people other than the owner) who lose access. */
  people: number;
  /** Every device that loses access: owner devices, member browsers and nodes. */
  devices: number;
  ownerDevices: number;
  memberDevices: number;
  nodes: number;
};

/** An unlink waiting for Discovery's confirmation (pending-unlink.ts sends it). */
type PendingUnlink = NonNullable<StoredClaw["pending_unlinks"]>[number];

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

type LinkedRecord = StoredClaw & {
  authority: AuthorityState;
  binding: NonNullable<StoredClaw["binding"]>;
  hostname: string;
};

// The linked record, or why this claw cannot be unlinked now.
function linkedRecord(record: StoredClaw | undefined): LinkedRecord | AuthorityRefusal {
  if (!record?.authority || !record.binding || !record.hostname) {
    return refusal("not_linked", "this claw is not linked");
  }
  const bindingSeq = record.binding.body.binding_seq;
  // Discovery accepts an unlink only for the binding it stores. A moved or reset binding that
  // is not confirmed published could never be unlinked there, so publish it first.
  if (
    record.discovery.owner_account_id &&
    record.discovery.published_binding_seq < bindingSeq &&
    bindingSeq > 1
  ) {
    return refusal(
      "binding_unpublished",
      "Discovery doesn't have this claw's current keys yet: publish them first (openclaw id status, openclaw id publish --code <link-code>), then unlink",
    );
  }
  return {
    ...record,
    authority: record.authority,
    binding: record.binding,
    hostname: record.hostname,
  };
}

function preview(record: LinkedRecord): UnlinkPreview {
  const state = record.authority;
  const ownerDevices = Object.keys(state.owner_devices).length;
  const memberDevices = Object.values(state.members).reduce(
    (count, member) => count + member.peer_keys.length,
    0,
  );
  const nodes = Object.keys(state.nodes).length;
  return {
    claw_id: record.claw_id,
    hostname: record.hostname,
    people: Object.keys(state.members).length,
    devices: ownerDevices + memberDevices + nodes,
    ownerDevices,
    memberDevices,
    nodes,
  };
}

// The side effects of removing everyone: every listed key and every tunnel-bound token's key
// loses access, connections close, members' runs stop and node pairings go.
function unlinkEvents(record: LinkedRecord): AuthorityEvent[] {
  const state = record.authority;
  const nodes = Object.keys(state.nodes).filter(isIrohEndpointKey);
  const removed = [
    ...new Set<IrohEndpointKey>([
      ...Object.values(state.members).flatMap((member) => member.peer_keys),
      ...Object.values(state.owner_devices).flatMap((device) => device.cert.body.peer_keys),
      ...nodes,
      ...(record.token_bindings ?? []).map((binding) => binding.peer_key).filter(isIrohEndpointKey),
    ]),
  ];
  return [
    ...(removed.length > 0
      ? [
          { type: "disconnect" as const, peer_keys: removed },
          { type: "invalidate_tokens" as const, peer_keys: removed },
        ]
      : []),
    ...Object.keys(state.members).map((account_id) => ({
      type: "cancel_runs" as const,
      account_id,
    })),
    ...(nodes.length > 0 ? [{ type: "remove_node_pairings" as const, peer_keys: nodes }] : []),
  ];
}

/** An unlinked claw Discovery has not confirmed, as the link summary shows it. */
export type PendingUnlinkSummary = { hostname: string; refused?: string };

/** Unlinked claws Discovery has not confirmed yet, linked again or not, for the link summary. */
export function pendingUnlinkHosts(record: StoredClaw | undefined): {
  pendingUnlinks?: PendingUnlinkSummary[];
} {
  const pending = (record?.pending_unlinks ?? []).map(({ hostname, refused }) =>
    refused ? { hostname, refused } : { hostname },
  );
  return pending.length ? { pendingUnlinks: pending } : {};
}

export function createUnlinkOperations(owner: {
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredClaw | undefined>;
  commit: (record: StoredClaw, assertCurrent?: () => void) => Promise<void>;
  /** A fresh, unlinked record for `clawId`. */
  emptyRecord: (clawId: string) => StoredClaw;
}) {
  const { serialize, load, commit } = owner;
  return {
    /** Who and what an unlink would cut now. Commits nothing. */
    unlinkPreview(): Promise<UnlinkPreview | AuthorityRefusal> {
      return serialize(async () => {
        const record = linkedRecord(await load());
        return "ok" in record ? record : preview(record);
      });
    },

    /**
     * Unlinks this claw, only over direct loopback, if it is still `clawId`, the claw whose
     * warning the owner confirmed (`claw_changed` otherwise). `gateway` must be the K_gw of the
     * current binding. Commits the fresh record with the signed ClawUnlink added to the pending unlinks
     * for `discoveryUrl` (none when Discovery is not configured or `neverRegistered`: no
     * registration was ever sent), and returns the removal effects.
     */
    commitUnlink(
      channel: Channel | undefined,
      clawId: string,
      gateway: StatementSigner,
      gatewayPub: string,
      discoveryUrl: string | undefined,
    ): Promise<
      | (AuthorityAccepted & {
          unlink: SignedStatement<"ClawUnlink">;
          removed: UnlinkPreview;
          neverRegistered: boolean;
        })
      | AuthorityRefusal
    > {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return refusal("not_local_operator", "unlinking needs direct loopback");
        }
        const record = linkedRecord(await load());
        if ("ok" in record) {
          return record;
        }
        if (record.claw_id !== clawId) {
          return refusal("claw_changed", "this claw changed since the warning: check it again");
        }
        if (gatewayPub !== record.binding.body.k_gw) {
          return refusal("key_mismatch", "this computer's Gateway key isn't the claw's");
        }
        const unlink = await signStatement(
          "ClawUnlink",
          { claw_id: record.claw_id, binding_seq: record.binding.body.binding_seq },
          gateway,
        );
        const neverRegistered =
          !record.discovery.owner_account_id && record.discovery.registration_unsent === true;
        const pending: PendingUnlink[] = [
          ...(record.pending_unlinks ?? []),
          ...(discoveryUrl && !neverRegistered
            ? [{ statement: unlink, hostname: record.hostname, discovery_url: discoveryUrl }]
            : []),
        ];
        const next: StoredClaw = {
          ...owner.emptyRecord(bytesToHex(randomBytes(16))),
          ...(record.token_bindings?.length ? { token_bindings: record.token_bindings } : {}),
          ...(pending.length ? { pending_unlinks: pending } : {}),
        };
        await commit(next);
        return {
          ok: true,
          status: "applied",
          events: unlinkEvents(record),
          unlink,
          removed: preview(record),
          neverRegistered,
        };
      });
    },

    /**
     * Records, before a registration of `clawId` is sent, that Discovery may hold it from now
     * on. False when `clawId` is no longer the linked claw (unlinked meanwhile): send nothing.
     */
    registrationSending(clawId: string): Promise<boolean> {
      return serialize(async () => {
        const current = await load();
        if (current?.claw_id !== clawId || !current.authority) {
          return false;
        }
        if (current.discovery.registration_unsent) {
          await commit({
            ...current,
            discovery: { ...current.discovery, registration_unsent: false },
          });
        }
        return true;
      });
    },

    /** Drops a pending unlink Discovery confirmed, or marks one it refused for good. */
    settlePendingUnlink(
      statement: SignedStatement<"ClawUnlink">,
      outcome: { kind: "confirmed" } | { kind: "refused"; code: string },
    ): Promise<void> {
      return serialize(async () => {
        const current = await load();
        const pending = current?.pending_unlinks ?? [];
        if (!current || !pending.some((entry) => entry.statement.sig === statement.sig)) {
          return;
        }
        const kept = pending.flatMap((entry) =>
          entry.statement.sig !== statement.sig
            ? [entry]
            : outcome.kind === "confirmed"
              ? []
              : [{ ...entry, refused: outcome.code }],
        );
        const { pending_unlinks: _all, ...rest } = current;
        await commit(kept.length ? { ...rest, pending_unlinks: kept } : rest);
      });
    },
  };
}
