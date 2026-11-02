// The ServerBinding check of the root ceremonies (link and owner-key regeneration).
import {
  parseStatement,
  verifyOwnerStatement,
  type AuthorityState,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityRefusal } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";

/** Expected binding fields: the claw's keys, and the binding seq and epoch to sign for. */
export type ExpectedBinding = {
  kSrv: IrohEndpointKey;
  kGw: Ed25519PublicKey;
  bindingSeq: number;
  rootEpoch: number;
};

/**
 * Verifies a binding under the new anchor (signed by R) and that it names exactly this
 * claw, at the expected binding seq and root epoch.
 */
export async function verifyBinding(
  state: AuthorityState,
  input: unknown,
  record: StoredClaw,
  expected: ExpectedBinding,
  now: number,
): Promise<{ ok: true; statement: SignedStatement<"ServerBinding"> } | AuthorityRefusal> {
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
    body.binding_seq !== expected.bindingSeq ||
    body.root_epoch !== expected.rootEpoch
  ) {
    return { ok: false, code: "target_mismatch", detail: "binding does not name this claw's keys" };
  }
  return { ok: true, statement: parsed.statement };
}
