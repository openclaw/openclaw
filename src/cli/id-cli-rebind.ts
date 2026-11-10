// `openclaw id rebind`: moves this claw to new machine keys with its recovery kit
// (OpenClaw ID re-bind, enrollment.md "Re-bind"). The Gateway stages the keys and
// stores the binding; the owner root R is derived here, from the kit typed on this
// machine, signs the binding (`signRebind`) and is dropped. The kit never reaches the
// Gateway or argv.
import {
  displayFingerprint,
  fingerprint,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type RebindPreparation,
  type SignedStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";

/** Human-checkable fingerprint of a public key. */
export async function displayKey(key: Ed25519PublicKey | IrohEndpointKey): Promise<string> {
  return displayFingerprint(await fingerprint(key));
}

/** The confirmation the operator answers before the binding is signed. */
export async function describeRebind(
  prep: RebindPreparation,
  binding: SignedStatement<"ServerBinding">,
): Promise<string> {
  return [
    `Move ${prep.hostname} to new keys?`,
    `  Owner root:   ${await displayKey(prep.root_pub)} (matches your recovery kit)`,
    `  Binding:      ${prep.current.binding_seq} -> ${binding.body.binding_seq}`,
    `  Endpoint key: ${await displayKey(prep.current.k_srv)} -> ${await displayKey(prep.k_srv)}`,
    `  Gateway key:  ${await displayKey(prep.current.k_gw)} -> ${await displayKey(prep.k_gw)}`,
    "Your devices, people, nodes and invites stay. Every connected device disconnects for a",
    "moment and reconnects by itself.",
  ].join("\n");
}
