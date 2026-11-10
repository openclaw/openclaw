// "Move to new keys" from the local Control UI (enrollment.md, "Re-bind"). The Gateway stages
// the keys and stores the binding; the owner root R is derived here from the recovery code typed
// in this browser, signs the binding (`signRebind`, which also verifies Discovery's published
// binding under R: J7) and is dropped. The account's link code is fetched, never pasted.
import {
  decodeKit,
  displayFingerprint,
  fingerprint,
  signRebind,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type RebindPreparation,
  type RebindSignRefusal,
  type SignedStatement,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { guardOpenClawIdAccount, requestOpenClawIdLinkCode } from "./account.ts";
import type { OpenClawIdSignedIn } from "./types.ts";

/** A signed move, shown for confirmation before it is committed. */
export type RebindPlan = {
  /** The account that supplied the code must still own this browser ceremony at commit. */
  assertCurrent: () => void;
  hostname: string;
  code: string;
  binding: SignedStatement<"ServerBinding">;
  root: string;
  bindingSeq: { from: number; to: number };
  endpoint: { from: string; to: string };
  gateway: { from: string; to: string };
};

/** Why nothing was signed: not a recovery code, or `signRebind`'s refusal. */
export type RebindRefusal = { ok: false; code: "bad_kit" } | RebindSignRefusal;

const display = async (key: Ed25519PublicKey | IrohEndpointKey) =>
  displayFingerprint(await fingerprint(key));

/**
 * Stages the next keys and signs their binding with the kit. Nothing is committed. Staged keys
 * stay for the next try, as with `openclaw id rebind`; `cancelRebind` deletes them.
 */
export async function prepareRebind(params: {
  client: GatewayBrowserClient;
  signedIn: OpenClawIdSignedIn;
  kitText: string;
}): Promise<{ ok: true; plan: RebindPlan } | RebindRefusal> {
  const { client } = params;
  const assertCurrent = guardOpenClawIdAccount(params.signedIn);
  assertCurrent();
  // Text that is not a recovery code is refused before anything is staged.
  const secret = await decodeKit(params.kitText).catch(() => null);
  if (!secret) {
    return { ok: false, code: "bad_kit" };
  }
  secret.fill(0);
  const code = await requestOpenClawIdLinkCode(client, params.signedIn);
  const prep = await client.request<RebindPreparation>("openclawId.authority", {
    action: "rebind_prepare",
    code,
  });
  assertCurrent();
  const signed = await signRebind(prep, params.kitText);
  assertCurrent();
  if (!signed.ok) {
    return signed;
  }
  const plan: RebindPlan = {
    assertCurrent,
    hostname: prep.hostname,
    code,
    binding: signed.binding,
    root: await display(prep.root_pub),
    bindingSeq: { from: prep.current.binding_seq, to: signed.binding.body.binding_seq },
    endpoint: { from: await display(prep.current.k_srv), to: await display(prep.k_srv) },
    gateway: { from: await display(prep.current.k_gw), to: await display(prep.k_gw) },
  };
  assertCurrent();
  return { ok: true, plan };
}

/** Stores the signed binding; remote access restarts on the new keys and publishes them. */
export async function commitRebind(client: GatewayBrowserClient, plan: RebindPlan) {
  plan.assertCurrent();
  return await client.request<{ ok: true; bindingSeq: number }>("openclawId.authority", {
    action: "rebind_commit",
    binding: plan.binding,
    code: plan.code,
  });
}

/** Deletes keys staged for a move that was not committed. */
export async function cancelRebind(client: GatewayBrowserClient): Promise<void> {
  await client.request("openclawId.authority", { action: "rebind_cancel" });
}

/** Publishes the committed keys with a fresh link code from the signed-in account. */
export async function publishWithLinkCode(
  client: GatewayBrowserClient,
  signedIn: OpenClawIdSignedIn,
) {
  const assertCurrent = guardOpenClawIdAccount(signedIn);
  const code = await requestOpenClawIdLinkCode(client, signedIn);
  assertCurrent();
  return await client.request<{ publication: { state: string; code?: string } | null }>(
    "openclawId.authority",
    { action: "publish", enrollmentCode: code },
  );
}
