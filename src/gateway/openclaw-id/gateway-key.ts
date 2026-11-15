// The Gateway signing key K_gw (Ed25519). It signs membership snapshots and
// Discovery requests. Held only by the Gateway, never by the tunnel child: a
// 32-byte seed in a 0600 file next to (but separate from) the endpoint key.
import path from "node:path";
import {
  ed25519SignerFromSeed,
  formatEd25519PublicKey,
  rawPublicKey,
  type Ed25519PublicKey,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  ed25519PublicKeyHex,
  loadBoundKey,
  loadOrCreateEndpointKey,
  stagedKeyPath,
  type BoundKeyRefusal,
} from "./tunnel-child/keyfile.js";

/** The linked claw's binding names a K_gw that no key file on this machine holds. */
export class GatewayKeyRefusedError extends Error {
  constructor(readonly reason: BoundKeyRefusal) {
    super(
      reason === "keys_missing"
        ? "the Gateway key this claw is bound to is missing"
        : "the Gateway key file is not the key this claw is bound to",
    );
  }
}

/** Where K_gw lives under the state directory. */
export function gatewayKeyPath(stateDir: string): string {
  return path.join(stateDir, "openclaw-id", "gateway.key");
}

/**
 * Loads K_gw. With `bound` (the K_gw the stored binding names) it applies the key
 * rule and never creates a key: a missing or different key throws
 * GatewayKeyRefusedError. Without a binding it creates the key on first use.
 */
export async function loadGatewaySigner(
  stateDir: string,
  bound?: Ed25519PublicKey,
): Promise<{ signer: StatementSigner; pub: Ed25519PublicKey }> {
  const file = gatewayKeyPath(stateDir);
  let key: Buffer;
  if (bound) {
    const loaded = loadBoundKey(file, Buffer.from(rawPublicKey(bound)).toString("hex"));
    if ("refused" in loaded) {
      throw new GatewayKeyRefusedError(loaded.refused);
    }
    key = loaded.key;
  } else {
    key = loadOrCreateEndpointKey(file).key;
  }
  const signer = await ed25519SignerFromSeed(key);
  key.fill(0);
  return { signer, pub: formatEd25519PublicKey(signer.publicKey) };
}

/** Signs with the staged next K_gw (a re-bind's Discovery lookup, before any binding names it). */
export async function loadStagedGatewaySigner(stateDir: string): Promise<StatementSigner> {
  const { key } = loadOrCreateEndpointKey(stagedKeyPath(gatewayKeyPath(stateDir)));
  const signer = await ed25519SignerFromSeed(key);
  key.fill(0);
  return signer;
}

/**
 * Creates the next K_gw for a re-bind in the staged `.next` file, or reuses the one staged
 * before, and returns its public key. It becomes the Gateway key once a binding names it.
 */
export function stageGatewayKey(stateDir: string): Ed25519PublicKey {
  const { key } = loadOrCreateEndpointKey(stagedKeyPath(gatewayKeyPath(stateDir)));
  const pub = formatEd25519PublicKey(Buffer.from(ed25519PublicKeyHex(key), "hex"));
  key.fill(0);
  return pub;
}
