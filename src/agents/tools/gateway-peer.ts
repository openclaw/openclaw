import { loadConfig } from "../../config/config.js";
import { resolveSecretInputString } from "../../secrets/resolve-secret-input-string.js";
import { readStringParam } from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";

/**
 * Resolve cross-gateway targeting from tool params.
 *
 * Supports three param shapes:
 * 1. `gateway: "peerName"` → looks up `gateway.peers[peerName]` in config
 * 2. `gatewayUrl` + optional `gatewayToken` → explicit URL override
 * 3. Neither → local gateway (returns undefined)
 *
 * Peer names take precedence when `gateway` is provided alongside `gatewayUrl`.
 */
export async function resolveGatewayPeerOptions(
  params: Record<string, unknown>,
): Promise<GatewayCallOptions | undefined> {
  const gatewayParam = readStringParam(params, "gateway")?.trim();
  const gatewayUrl = readStringParam(params, "gatewayUrl")?.trim();
  const gatewayToken = readStringParam(params, "gatewayToken")?.trim();

  // Named peer lookup
  if (gatewayParam) {
    const cfg = loadConfig();
    const peers = cfg.gateway?.peers;
    if (!peers || typeof peers !== "object") {
      throw new Error(
        `Gateway peer "${gatewayParam}" not found. No gateway.peers configured. ` +
          `Add it to your config: gateway.peers.${gatewayParam}.url`,
      );
    }
    const peer = peers[gatewayParam];
    if (!peer || typeof peer.url !== "string" || !peer.url.trim()) {
      const available = Object.keys(peers).join(", ") || "(none)";
      throw new Error(`Gateway peer "${gatewayParam}" not found. Available peers: ${available}`);
    }

    let resolvedToken: string | undefined;
    if (peer.token !== undefined && peer.token !== null) {
      try {
        resolvedToken =
          (await resolveSecretInputString({
            config: cfg,
            value: peer.token,
            env: process.env,
          })) ?? undefined;
      } catch (err) {
        // Token was explicitly configured but resolution failed (e.g. missing
        // env var or secret ref).  This is almost certainly a misconfiguration
        // — proceeding without auth would silently fail on the remote gateway.
        throw new Error(
          `Gateway peer "${gatewayParam}": token configured but could not be resolved — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return {
      gatewayUrl: peer.url.trim(),
      gatewayToken: gatewayToken || resolvedToken,
    };
  }

  // Explicit URL override
  if (gatewayUrl) {
    return { gatewayUrl, gatewayToken };
  }

  // Local gateway
  return undefined;
}
