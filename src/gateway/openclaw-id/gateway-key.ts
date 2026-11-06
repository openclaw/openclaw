// The Gateway signing key K_gw (Ed25519). It signs membership snapshots and
// Discovery requests. Held only by the Gateway, never by the tunnel child: a
// 32-byte seed in a 0600 file next to (but separate from) the endpoint key.
import path from "node:path";
import {
  ed25519SignerFromSeed,
  formatEd25519PublicKey,
  type Ed25519PublicKey,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { loadOrCreateEndpointKey } from "./tunnel-child/keyfile.js";

/** Loads or creates K_gw under the state directory. */
export async function loadGatewaySigner(
  stateDir: string,
): Promise<{ signer: StatementSigner; pub: Ed25519PublicKey }> {
  const { key } = loadOrCreateEndpointKey(path.join(stateDir, "openclaw-id", "gateway.key"));
  const signer = await ed25519SignerFromSeed(key);
  key.fill(0);
  return { signer, pub: formatEd25519PublicKey(signer.publicKey) };
}
