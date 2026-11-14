// Re-bind (enrollment.md, "Re-bind"): the owner root R signs a new ServerBinding at a
// higher binding_seq naming new K_srv and K_gw, under the same root. These operations
// run in the authority owner's serialized load/commit lane, so a re-bind, a link or a
// membership write never interleave. Only the stored binding changes: owner devices,
// members, nodes, invites and the membership seq all stay.
import {
  parseStatement,
  ROOT_EPOCH,
  type Channel,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import { verifyBinding } from "./binding-check.js";
import type { StoredClaw } from "./claw-store.js";

/** The machine keys a binding names. */
type BoundKeys = { k_srv: IrohEndpointKey; k_gw: Ed25519PublicKey };

/** What R signs for a re-bind, and the binding it replaces (for display). */
export type RebindPreparation = BoundKeys & {
  claw_id: string;
  hostname: string;
  root_pub: Ed25519PublicKey;
  binding_seq: number;
  root_epoch: typeof ROOT_EPOCH;
  current: BoundKeys & { binding_seq: number };
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The lowest binding_seq a re-bind may sign: one above the stored binding. The owner's CLI
 * signs above Discovery's verified published binding when that is higher (a restored backup).
 */
function nextBindingSeq(record: StoredClaw & { binding: NonNullable<StoredClaw["binding"]> }) {
  return record.binding.body.binding_seq + 1;
}

// The linked record, or the refusal for a claw that cannot re-bind.
function linkedRecord(record: StoredClaw | undefined) {
  if (!record?.authority || !record.binding || !record.hostname) {
    return { ok: false as const, code: "not_linked", detail: "this claw is not linked" };
  }
  return {
    ok: true as const,
    record: {
      ...record,
      binding: record.binding,
      authority: record.authority,
      hostname: record.hostname,
    },
  };
}

// Both staged keys must differ from the bound ones: the ceremony always replaces both.
function replacesBoth(
  record: StoredClaw & { binding: NonNullable<StoredClaw["binding"]> },
  keys: { kSrv: IrohEndpointKey; kGw: Ed25519PublicKey },
) {
  return record.binding.body.k_srv !== keys.kSrv && record.binding.body.k_gw !== keys.kGw;
}

export function createRebindOperations(owner: {
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredClaw | undefined>;
  commit: (record: StoredClaw, assertCurrent?: () => void) => Promise<void>;
}) {
  const { serialize, load, commit } = owner;
  return {
    /** The binding R signs to move this claw to the staged keys. Commits nothing. */
    prepareRebind(staged: {
      kSrv: IrohEndpointKey;
      kGw: Ed25519PublicKey;
    }): Promise<RebindPreparation | AuthorityRefusal> {
      return serialize(async () => {
        const linked = linkedRecord(await load());
        if (!linked.ok) {
          return linked;
        }
        const { record } = linked;
        if (!replacesBoth(record, staged)) {
          return { ok: false, code: "target_mismatch", detail: "a re-bind replaces both keys" };
        }
        const current = record.binding.body;
        return {
          claw_id: record.claw_id,
          hostname: record.hostname,
          root_pub: record.authority.anchor.root_pub,
          k_srv: staged.kSrv,
          k_gw: staged.kGw,
          binding_seq: nextBindingSeq(record),
          root_epoch: ROOT_EPOCH,
          current: { k_srv: current.k_srv, k_gw: current.k_gw, binding_seq: current.binding_seq },
        };
      });
    },

    /**
     * Replaces the stored binding with an R-signed one that names exactly the staged keys at a
     * binding_seq above the stored one. Only over direct loopback. A reset or another re-bind
     * committed since prepare fails here (wrong signer, or `rollback`).
     */
    commitRebind(
      input: unknown,
      channel: Channel | undefined,
      staged: { kSrv: IrohEndpointKey; kGw: Ed25519PublicKey },
      /** Service-owned lifetime, retained through verification and durable write admission. */
      isCurrent?: () => boolean,
    ): Promise<(AuthorityAccepted & { bindingSeq: number }) | AuthorityRefusal> {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return {
            ok: false,
            code: "not_local_operator",
            detail: "a re-bind needs direct loopback",
          };
        }
        const linked = linkedRecord(await load());
        if (!linked.ok) {
          return linked;
        }
        const { record } = linked;
        if (!replacesBoth(record, staged)) {
          return { ok: false, code: "target_mismatch", detail: "a re-bind replaces both keys" };
        }
        const parsed = parseStatement(input, "ServerBinding");
        if (!parsed.ok) {
          return { ok: false, code: "malformed", detail: parsed.detail };
        }
        const bindingSeq = parsed.statement.body.binding_seq;
        if (bindingSeq < nextBindingSeq(record)) {
          return { ok: false, code: "rollback", detail: "binding_seq is not above the stored one" };
        }
        const binding = await verifyBinding(
          record.authority,
          input,
          record,
          { ...staged, bindingSeq },
          nowSeconds(),
        );
        if (!binding.ok) {
          return binding;
        }
        const cancelled = new Error("the re-bind lifetime ended");
        const assertCurrent = () => {
          if (isCurrent && !isCurrent()) {
            throw cancelled;
          }
        };
        try {
          assertCurrent();
          await commit({ ...record, binding: binding.statement }, assertCurrent);
        } catch (error) {
          // Storage wraps a refused host admission; uncertain outcomes remain errors.
          if (error === cancelled || (error instanceof Error && error.cause === cancelled)) {
            return { ok: false, code: "rebind_cancelled", detail: cancelled.message };
          }
          throw error;
        }
        // Members' rows at Discovery follow the snapshot published for the new binding.
        return { ok: true, status: "applied", events: [{ type: "publish_snapshot" }], bindingSeq };
      });
    },
  };
}
