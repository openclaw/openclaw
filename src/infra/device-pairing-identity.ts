import { createHash } from "node:crypto";
import type { NodePairingGeneration, NodePairingState } from "./device-pairing-core.types.js";
import {
  mergeDevicePairingRoles,
  normalizeDevicePairingRole,
} from "./device-pairing-state.kernel.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
export type { NodePairingGeneration, NodePairingState } from "./device-pairing-core.types.js";

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

/** Resolve the authenticated node pairing independently of surface approval. */
function resolveNodePairingIdentity(
  device: PairedDevice | null,
): NodePairingState["identity"] | null {
  if (!device || !hasEffectivePairedDeviceRole(device, "node")) {
    return null;
  }
  const nodeToken = device.tokens?.node;
  if (!nodeToken) {
    return null;
  }
  const key = createHash("sha256")
    .update(
      [
        device.publicKey,
        device.createdAtMs,
        nodeToken.token,
        nodeToken.createdAtMs,
        nodeToken.rotatedAtMs ?? "",
        nodeToken.revokedAtMs ?? "",
      ].join("\0"),
    )
    .digest("hex");
  return { nodeId: device.deviceId, key };
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
  const key = createHash("sha256")
    .update(
      [
        device.publicKey,
        device.createdAtMs,
        nodeToken?.token ?? "",
        nodeToken?.revokedAtMs ?? "",
        nodeSurface.createdAtMs,
        nodeSurface.approvedAtMs,
      ].join("\0"),
    )
    .digest("hex");
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
  const identity = resolveNodePairingIdentity(device);
  if (!identity) {
    return null;
  }
  return { identity, generation: resolveNodePairingGeneration(device) };
}
