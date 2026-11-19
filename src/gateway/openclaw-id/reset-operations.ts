// Owner reset (enrollment.md, "Owner reset"; OCF-319): the person at the machine replaces the
// claw's root R with a new root R' from a new recovery kit. These operations run in the
// authority owner's serialized load/commit lane, so a reset never interleaves with a link,
// re-bind or membership write.
//
// A reset keeps the claw id, hostname, K_srv and the membership seq (which keeps counting up)
// and moves to the staged K_gw'. It removes every owner device, member, node and invite. R'
// signs the new binding at binding_seq + 1 naming K_gw', and the current K_gw vouches for the
// root change with a RootReset; both are published together in the descriptor's `reset`
// evidence, with the owner account's code (Discovery's rule for a new K_gw).
import {
  isEd25519PublicKey,
  isIrohEndpointKey,
  parseStatement,
  ROOT_EPOCH,
  signStatement,
  submitStatement,
  type AuthorityEvent,
  type AuthorityState,
  type Channel,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type RootResetEvidence,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { memberKeys } from "./authority-keys.js";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import { verifyBinding } from "./binding-check.js";
import type { StoredClaw } from "./claw-store.js";

/** What a new root R' signs for an owner reset, and what the reset removes (for display). */
export type ResetPreparation = {
  claw_id: string;
  hostname: string;
  /** The root being replaced. */
  root_pub: Ed25519PublicKey;
  k_srv: IrohEndpointKey;
  /** The staged K_gw' the new binding names. */
  k_gw: Ed25519PublicKey;
  binding_seq: number;
  root_epoch: typeof ROOT_EPOCH;
  /** The seq of an R'-signed add_owner_device enrolling the resetting browser. */
  owner_device_seq: number;
  removes: { ownerDevices: number; members: number; nodes: number; invites: number };
};

/** The new root's signed statements: its binding and, from a browser, its own owner device. */
export type ResetCommit = {
  root_pub: unknown;
  binding: unknown;
  owner_device?: unknown;
};

/** What a committed reset removed. */
export type ResetRemoved = ResetPreparation["removes"];

const nowSeconds = () => Math.floor(Date.now() / 1000);

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

type LinkedRecord = StoredClaw & {
  authority: AuthorityState;
  binding: NonNullable<StoredClaw["binding"]>;
  hostname: string;
};

// The linked record, or why this claw cannot be reset.
function linkedRecord(record: StoredClaw | undefined): LinkedRecord | AuthorityRefusal {
  if (!record?.authority || !record.binding || !record.hostname) {
    return refusal("not_linked", "this claw is not linked");
  }
  const bindingSeq = record.binding.body.binding_seq;
  // Discovery accepts a reset only from the binding it stores. Until the current binding is
  // confirmed published, this computer can't tell which one that is (a descriptor can land
  // before its snapshot fails), so a reset waits for the earlier move or reset to publish.
  if (
    record.discovery.owner_account_id &&
    record.discovery.published_binding_seq < bindingSeq &&
    bindingSeq > 1
  ) {
    return pendingReset(record)
      ? refusal(
          "reset_unpublished",
          "the last owner reset isn't published yet: wait for it (openclaw id status), then reset",
        )
      : refusal(
          "rebind_unpublished",
          "publish the move to new keys first (openclaw id publish --code <link-code>), then reset",
        );
  }
  return {
    ...record,
    authority: record.authority,
    binding: record.binding,
    hostname: record.hostname,
  };
}

/** The reset evidence of the current binding while Discovery has not confirmed it. */
export function pendingReset(record: StoredClaw): RootResetEvidence | undefined {
  const bindingSeq = record.binding?.body.binding_seq;
  return record.reset?.statement.body.binding_seq === bindingSeq &&
    record.discovery.published_binding_seq < (bindingSeq ?? 0)
    ? record.reset
    : undefined;
}

function removes(state: AuthorityState): ResetRemoved {
  return {
    ownerDevices: Object.keys(state.owner_devices).length,
    members: Object.keys(state.members).length,
    nodes: Object.keys(state.nodes).length,
    invites: Object.keys(state.invites).length + Object.keys(state.node_invites).length,
  };
}

// The side effects of removing everyone: every listed key and every tunnel-bound token's key
// loses access, connections close, members' runs stop and node pairings go.
function resetEvents(record: LinkedRecord): AuthorityEvent[] {
  const state = record.authority;
  const nodes = Object.keys(state.nodes).filter(isIrohEndpointKey);
  const removed = [
    ...new Set<IrohEndpointKey>([
      ...memberKeys(state),
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
    { type: "publish_snapshot" },
  ];
}

/** The staged next Gateway key; a reset always moves to it. */
export type ResetStagedKey = { kGw: Ed25519PublicKey };

// The staged key must differ from the bound one: a reset always replaces K_gw.
const replacesGatewayKey = (record: LinkedRecord, staged: ResetStagedKey) =>
  record.binding.body.k_gw !== staged.kGw;

const keepsGatewayKey = () => refusal("target_mismatch", "a reset replaces the Gateway key");

export function createResetOperations(owner: {
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredClaw | undefined>;
  commit: (record: StoredClaw, assertCurrent?: () => void) => Promise<void>;
}) {
  const { serialize, load, commit } = owner;
  return {
    /** What R' signs to reset this claw onto the staged K_gw'. Commits nothing. */
    prepareReset(staged: ResetStagedKey): Promise<ResetPreparation | AuthorityRefusal> {
      return serialize(async () => {
        const record = linkedRecord(await load());
        if ("ok" in record) {
          return record;
        }
        if (!replacesGatewayKey(record, staged)) {
          return keepsGatewayKey();
        }
        const binding = record.binding.body;
        return {
          claw_id: record.claw_id,
          hostname: record.hostname,
          root_pub: record.authority.anchor.root_pub,
          k_srv: binding.k_srv,
          k_gw: staged.kGw,
          binding_seq: binding.binding_seq + 1,
          root_epoch: ROOT_EPOCH,
          owner_device_seq: record.authority.seq + 2,
          removes: removes(record.authority),
        };
      });
    },

    /**
     * Replaces the root with `input.root_pub` and removes everyone, only over direct loopback.
     * The binding must be signed by the new root for the same claw, hostname and K_srv and the
     * staged K_gw' at binding_seq + 1; `gateway` (K_gw of the current binding) signs the
     * RootReset. An
     * `owner_device` (R'-signed add_owner_device at the reset's seq + 1) enrolls the browser
     * that reset the claw. A reset or re-bind committed since prepare fails here (`target_mismatch`).
     */
    commitReset(
      input: ResetCommit,
      channel: Channel | undefined,
      gateway: StatementSigner,
      staged: ResetStagedKey,
      assertCurrent?: () => void,
    ): Promise<
      (AuthorityAccepted & { bindingSeq: number; removed: ResetRemoved }) | AuthorityRefusal
    > {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return refusal("not_local_operator", "an owner reset needs direct loopback");
        }
        const record = linkedRecord(await load());
        if ("ok" in record) {
          return record;
        }
        if (!isEd25519PublicKey(input.root_pub)) {
          return refusal("malformed", "root_pub must be an ed25519 public key");
        }
        if (input.root_pub === record.authority.anchor.root_pub) {
          return refusal("reset_mismatch", "a reset needs a new recovery kit");
        }
        if (!replacesGatewayKey(record, staged)) {
          return keepsGatewayKey();
        }
        const current = record.binding.body;
        const now = nowSeconds();
        const reset: AuthorityState = {
          claw_id: record.claw_id,
          anchor: { root_pub: input.root_pub },
          seq: record.authority.seq + 1,
          owner_devices: {},
          members: {},
          invites: {},
          nodes: {},
          node_invites: {},
        };
        const bindingSeq = current.binding_seq + 1;
        const binding = await verifyBinding(
          reset,
          input.binding,
          record,
          { kSrv: current.k_srv, kGw: staged.kGw, bindingSeq },
          now,
        );
        if (!binding.ok) {
          return binding;
        }
        let state = reset;
        const events = resetEvents(record);
        if (input.owner_device !== undefined) {
          const change = parseStatement(input.owner_device, "MembershipChange");
          if (!change.ok || change.statement.body.target.op !== "add_owner_device") {
            return refusal("malformed", "owner_device must add an owner device");
          }
          const added = await submitStatement(reset, input.owner_device, { channel, now });
          if (!added.ok) {
            return refusal(added.code, added.detail);
          }
          state = added.state;
          events.push(...added.events.filter((event) => event.type !== "publish_snapshot"));
        }
        const statement = await signStatement(
          "RootReset",
          {
            claw_id: record.claw_id,
            new_root_pub: input.root_pub,
            binding_seq: bindingSeq,
            issued_at: now,
          },
          gateway,
        );
        assertCurrent?.();
        await commit(
          {
            ...record,
            authority: state,
            binding: binding.statement,
            reset: {
              previous_root_pub: record.authority.anchor.root_pub,
              previous_binding: record.binding,
              statement,
            },
            invite_reports: {},
            member_approved_at: {},
          },
          assertCurrent,
        );
        return {
          ok: true,
          status: "applied",
          events,
          bindingSeq,
          removed: removes(record.authority),
        };
      });
    },
  };
}
