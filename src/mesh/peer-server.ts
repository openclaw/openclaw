import { randomUUID } from "node:crypto";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { buildMeshConnectAuth, verifyMeshConnectAuth } from "./handshake.js";
import type { PeerRegistry } from "./peer-registry.js";
import { isTrustedPeer } from "./peer-trust.js";
import type { MeshConnectParams, PeerSession } from "./types.js";

export type MeshServerHandlerDeps = {
  identity: DeviceIdentity;
  peerRegistry: PeerRegistry;
  displayName?: string;
  capabilities?: string[];
  onPeerConnected?: (session: PeerSession) => void;
};

/**
 * Create gateway request handlers for inbound mesh peer connections.
 */
export function createMeshServerHandlers(deps: MeshServerHandlerDeps): GatewayRequestHandlers {
  return {
    "mesh.connect": async ({ params, respond, req }) => {
      const p = params as unknown as MeshConnectParams;
      if (!p || !p.deviceId || !p.publicKey || !p.signature || !p.signedAtMs) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "missing required mesh.connect params",
        });
        return;
      }

      // Verify the peer is in our trust store.
      const trusted = await isTrustedPeer(p.deviceId);
      if (!trusted) {
        respond(false, undefined, {
          code: "UNTRUSTED_PEER",
          message: `peer ${p.deviceId} is not in the trust store`,
        });
        return;
      }

      // Verify the peer's Ed25519 signature.
      const valid = verifyMeshConnectAuth({
        deviceId: p.deviceId,
        publicKey: p.publicKey,
        signature: p.signature,
        signedAtMs: p.signedAtMs,
        nonce: p.nonce,
      });
      if (!valid) {
        respond(false, undefined, {
          code: "AUTH_FAILED",
          message: "mesh peer signature verification failed",
        });
        return;
      }

      // Build our own signed response for mutual authentication.
      const ourAuth = buildMeshConnectAuth({
        identity: deps.identity,
        displayName: deps.displayName,
        capabilities: deps.capabilities,
      });

      // Register the peer session.
      // The actual WebSocket is managed by the gateway WS infrastructure,
      // but we need to associate it with this peer for RPC routing.
      // In a real implementation, we'd get the WS from the request context.
      // For now, we register with a placeholder that the manager will update.
      const connId = (req as { _connId?: string })._connId ?? randomUUID();
      const session: PeerSession = {
        deviceId: p.deviceId,
        connId,
        displayName: p.displayName,
        publicKey: p.publicKey,
        socket: null as unknown as PeerSession["socket"], // Will be set by the WS handler layer
        outbound: false,
        capabilities: p.capabilities ?? [],
        connectedAtMs: Date.now(),
      };
      deps.peerRegistry.register(session);
      deps.onPeerConnected?.(session);

      respond(true, {
        deviceId: ourAuth.deviceId,
        publicKey: ourAuth.publicKey,
        signature: ourAuth.signature,
        signedAtMs: ourAuth.signedAtMs,
        displayName: ourAuth.displayName,
        capabilities: ourAuth.capabilities,
      });
    },
  };
}
