import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { NodePairingGeneration, NodePairingState } from "./device-pairing-core.types.js";
import {
  mergeDevicePairingRoles,
  normalizeDevicePairingRole,
} from "./device-pairing-state.kernel.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
export type { NodePairingGeneration, NodePairingState } from "./device-pairing-core.types.js";

export type PairedDeviceTokenIdentity = { deviceId: string; key: string };

/** Use the same persisted approval ceiling for token verification and retained authority. */
export function resolveApprovedDeviceScopeBaseline(device: PairedDevice): string[] | null {
  const baseline = device.approvedScopes ?? device.scopes;
  return Array.isArray(baseline) ? normalizeDeviceAuthScopes(baseline) : null;
}

/** Pin the credential actually accepted or issued, never a successor found on a later read. */
export function resolveAuthenticatedDeviceTokenIdentity(
  device: PairedDevice | null,
  authenticated: { role: string; publicKey: string; token: string; scopes: readonly string[] },
): PairedDeviceTokenIdentity | null {
  if (
    !device ||
    device.publicKey !== authenticated.publicKey ||
    device.tokens?.[authenticated.role]?.token !== authenticated.token
  ) {
    return null;
  }
  const identity = resolvePairedDeviceTokenIdentity(device, authenticated.role);
  return identity &&
    isPairedDeviceTokenIdentityCurrent(device, authenticated.role, identity, authenticated.scopes)
    ? Object.freeze(identity)
    : null;
}

function listActiveTokenRoles(
  tokens: Record<string, DeviceAuthToken> | undefined,
): string[] | undefined {
  if (!tokens) {
    return undefined;
  }
  return mergeDevicePairingRoles(
    Object.values(tokens)
      .filter((entry) => !entry.revokedAtMs)
      .map((entry) => entry.role),
  );
}

/** List the durable roles an owner approved for a paired device record. */
export function listApprovedPairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles">,
): string[] {
  // Approved roles come from the pairing record itself. This is the durable
  // contract the owner approved, independent of any currently active tokens.
  return mergeDevicePairingRoles(device.roles, device.role) ?? [];
}

/** List active-token roles, bounded by the durable approved pairing roles. */
export function listEffectivePairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
): string[] {
  const activeTokenRoles = listActiveTokenRoles(device.tokens);
  if (activeTokenRoles && activeTokenRoles.length > 0) {
    // Effective roles are the active token roles, bounded by the approved
    // pairing contract. A stray token entry must not grant new access.
    const approvedRoles = new Set(listApprovedPairedDeviceRoles(device));
    return activeTokenRoles.filter((role) => approvedRoles.has(role));
  }
  // Token entries are authoritative. Tokenless legacy records fail closed so
  // sticky historical role fields cannot retain access after token migration.
  return [];
}

/** Return whether a paired device currently has an active token for one role. */
export function hasEffectivePairedDeviceRole(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
  role: string,
): boolean {
  const normalized = normalizeDevicePairingRole(role);
  if (!normalized) {
    return false;
  }
  return listEffectivePairedDeviceRoles(device).includes(normalized);
}

/** Resolve one exact active role-token generation without exposing its credential. */
function resolvePairedDeviceTokenIdentity(
  device: PairedDevice | null,
  role: string,
): PairedDeviceTokenIdentity | null {
  const normalizedRole = normalizeDevicePairingRole(role);
  if (!device || !normalizedRole || !hasEffectivePairedDeviceRole(device, normalizedRole)) {
    return null;
  }
  const token = device.tokens?.[normalizedRole];
  if (!token || token.role !== normalizedRole || token.revokedAtMs) {
    return null;
  }
  const key = sha256Hex(
    [
      device.publicKey,
      device.createdAtMs,
      token.token,
      token.createdAtMs,
      token.rotatedAtMs ?? "",
      token.revokedAtMs ?? "",
    ].join("\0"),
  );
  return { deviceId: device.deviceId, key };
}

/** Re-admission retains the original token generation and current approved scope ceiling. */
export function isPairedDeviceTokenIdentityCurrent(
  device: PairedDevice | null,
  role: string,
  identity: PairedDeviceTokenIdentity,
  scopes: readonly string[],
): boolean {
  const normalizedRole = normalizeDevicePairingRole(role);
  const token = normalizedRole ? device?.tokens?.[normalizedRole] : undefined;
  const current = resolvePairedDeviceTokenIdentity(device, role);
  if (
    !device ||
    !normalizedRole ||
    !token ||
    !current ||
    current.deviceId !== identity.deviceId ||
    current.key !== identity.key
  ) {
    return false;
  }
  const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
  // Match live token verification: the whole token must remain approved, not
  // merely the scopes this continuation happens to request.
  return (
    approvedScopes !== null &&
    roleScopesAllow({
      role: normalizedRole,
      requestedScopes: token.scopes,
      allowedScopes: approvedScopes,
    }) &&
    roleScopesAllow({ role: normalizedRole, requestedScopes: scopes, allowedScopes: token.scopes })
  );
}

/** Resolve the durable node-owned identity used to admit asynchronous work. */
export function resolveNodePairingGeneration(
  device: PairedDevice | null,
): NodePairingGeneration | null {
  if (!device || !hasEffectivePairedDeviceRole(device, "node") || !device.nodeSurface) {
    return null;
  }
  const nodeToken = device.tokens?.node;
  const nodeSurface = device.nodeSurface;
  // Device-wide approval also changes for unrelated operator upgrades, so only
  // node-owned identity participates in the generation.
  const key = sha256Hex(
    [
      device.publicKey,
      device.createdAtMs,
      nodeToken?.token ?? "",
      nodeToken?.revokedAtMs ?? "",
      nodeSurface.createdAtMs,
      nodeSurface.approvedAtMs,
    ].join("\0"),
  );
  return { nodeId: device.deviceId, key };
}

/** Clear node runtime facts when their owning pairing generation changes. */
export function clearNodePairingGenerationState(
  device: PairedDevice,
  previousGeneration: NodePairingGeneration | null,
): void {
  const nextGeneration = resolveNodePairingGeneration(device);
  if (previousGeneration?.key === nextGeneration?.key || !device.nodeSurface) {
    return;
  }
  delete device.nodeSurface.bins;
  delete device.nodeSurface.sessionHost;
}

/** Resolve connection identity and optional approved surface generation from one row. */
export function resolveNodePairingState(device: PairedDevice | null): NodePairingState | null {
  const identity = resolvePairedDeviceTokenIdentity(device, "node");
  if (!identity) {
    return null;
  }
  return {
    identity: { nodeId: identity.deviceId, key: identity.key },
    generation: resolveNodePairingGeneration(device),
  };
}
