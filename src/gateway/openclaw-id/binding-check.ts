// The ServerBinding check of the link ceremony.
import {
  parseStatement,
  verifyOwnerStatement,
  type AuthorityState,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";

/** A refused binding, in the shape the authority returns to its caller. */
export type BindingRefusal = { ok: false; code: string; detail: string };

/** Expected binding fields: the claw's keys and the binding seq to sign for. */
export type ExpectedBinding = {
  kSrv: IrohEndpointKey;
  kGw: Ed25519PublicKey;
  bindingSeq: number;
};

/**
 * Verifies a binding under the anchor (signed by R) and that it names exactly this
 * claw, at the expected binding seq.
 */
export async function verifyBinding(
  state: AuthorityState,
  input: unknown,
  record: StoredClaw,
  expected: ExpectedBinding,
  now: number,
): Promise<{ ok: true; statement: SignedStatement<"ServerBinding"> } | BindingRefusal> {
  const parsed = parseStatement(input, "ServerBinding");
  if (!parsed.ok) {
    return { ok: false, code: "malformed", detail: parsed.detail };
  }
  const verified = await verifyOwnerStatement(parsed.statement, state.anchor, { now });
  if (!verified.ok) {
    return { ok: false, code: verified.code, detail: verified.detail };
  }
  const body = parsed.statement.body;
  if (
    body.claw_id !== record.claw_id ||
    body.hostname !== record.hostname ||
    body.k_srv !== expected.kSrv ||
    body.k_gw !== expected.kGw ||
    body.binding_seq !== expected.bindingSeq
  ) {
    return { ok: false, code: "target_mismatch", detail: "binding does not name this claw's keys" };
  }
  return { ok: true, statement: parsed.statement };
}
