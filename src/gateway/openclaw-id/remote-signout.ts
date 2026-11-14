// Remote sign-out ends browser credentials and RPC connections, not device membership.
import type { OpenClawIdAuthority } from "./authority.js";

// The connection effects sign-out uses from the service's removal effects.
type SignOutEffects = {
  captureConnections: (peerKeys: readonly string[]) => string[];
  closeConnections: (connectionIds: readonly string[]) => void;
};

/** Revokes only the authenticated tunnel peer's issued tokens while keeping its device approved. */
export async function signOutTunnelPeer(
  peerKey: string,
  authority: OpenClawIdAuthority,
  effects: SignOutEffects | undefined,
  stateDir: string,
): Promise<boolean> {
  if (!effects) {
    throw new Error("Gateway sign-out is unavailable");
  }
  if (!(await authority.resolvePeer(peerKey))) {
    return false;
  }
  const { revokeDeviceToken } = await import("../../infra/device-pairing-tokens.js");
  // The target comes from authenticated ingress, never a request body or browser-selected id.
  // Retire live RPC clients before the token writes so their issuance authority is invalidated.
  const connections = effects.captureConnections([peerKey]);
  effects.closeConnections(connections);
  const tokens =
    authority.current()?.token_bindings?.filter((token) => token.peer_key === peerKey) ?? [];
  for (const token of tokens) {
    const result = await revokeDeviceToken({
      deviceId: token.device_id,
      role: token.role,
      baseDir: stateDir,
    });
    // Already absent is revoked for this purpose. Other failures must not report success.
    if (!result.ok && result.reason !== "unknown-device-or-role") {
      throw new Error("Could not revoke this browser's Gateway token");
    }
  }
  // The bindings stay: they mark these as OpenClaw ID browsers, managed on the Access page,
  // and re-sign-in rebinds the re-issued token. Membership removal drops them.
  return true;
}
