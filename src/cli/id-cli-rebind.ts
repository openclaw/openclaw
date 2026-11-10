// `openclaw id rebind`: moves this claw to new machine keys with its recovery kit
// (OpenClaw ID re-bind, enrollment.md "Re-bind"). The Gateway stages the keys and
// stores the binding; the owner root R is derived here, from the kit typed on this
// machine, signs the binding and is dropped. The kit never reaches the Gateway or argv.
import {
  decodeKit,
  deriveRootSigner,
  displayFingerprint,
  fingerprint,
  formatEd25519PublicKey,
  signStatement,
  type ROOT_EPOCH,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type SignedStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";

/** What `openclawId.authority { action: "rebind_prepare" }` returns. */
export type RebindPreparation = {
  claw_id: string;
  hostname: string;
  root_pub: Ed25519PublicKey;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: number;
  root_epoch: typeof ROOT_EPOCH;
  current: { k_srv: IrohEndpointKey; k_gw: Ed25519PublicKey; binding_seq: number };
};

/** Human-checkable fingerprint of a public key. */
export async function displayKey(key: Ed25519PublicKey | IrohEndpointKey): Promise<string> {
  return displayFingerprint(await fingerprint(key));
}

/**
 * Derives R from the kit and signs the prepared binding. A kit for another claw signs
 * nothing: its root's fingerprint is returned so the operator can tell kits apart.
 */
export async function signRebind(
  prep: RebindPreparation,
  kitText: string,
  now = Math.floor(Date.now() / 1000),
): Promise<
  | { ok: true; binding: SignedStatement<"ServerBinding"> }
  | { ok: false; code: "wrong_kit"; kitRoot: string }
> {
  const secret = await decodeKit(kitText.trim());
  try {
    const root = await deriveRootSigner(secret);
    const rootPub = formatEd25519PublicKey(root.publicKey);
    if (rootPub !== prep.root_pub) {
      return { ok: false, code: "wrong_kit", kitRoot: await displayKey(rootPub) };
    }
    const binding = await signStatement(
      "ServerBinding",
      {
        claw_id: prep.claw_id,
        hostname: prep.hostname,
        k_srv: prep.k_srv,
        k_gw: prep.k_gw,
        binding_seq: prep.binding_seq,
        root_epoch: prep.root_epoch,
        issued_at: now,
      },
      root,
    );
    return { ok: true, binding };
  } finally {
    secret.fill(0);
  }
}

/** The confirmation the operator answers before the binding is signed. */
export async function describeRebind(prep: RebindPreparation): Promise<string> {
  return [
    `Move ${prep.hostname} to new keys?`,
    `  Owner root:   ${await displayKey(prep.root_pub)} (matches your recovery kit)`,
    `  Binding:      ${prep.current.binding_seq} -> ${prep.binding_seq}`,
    `  Endpoint key: ${await displayKey(prep.current.k_srv)} -> ${await displayKey(prep.k_srv)}`,
    `  Gateway key:  ${await displayKey(prep.current.k_gw)} -> ${await displayKey(prep.k_gw)}`,
    "Your devices, people, nodes and invites stay. Every connected device disconnects for a",
    "moment and reconnects by itself.",
  ].join("\n");
}
