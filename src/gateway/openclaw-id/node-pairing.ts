// The service supplies owner-approved descriptions; the pairing worker owns once-only persistence.
import type { DevicePairingAccessMetadata } from "../../infra/device-pairing-core.types.js";
import { publishDevicePairingResolution } from "../../infra/device-pairing-resolution.js";
import { resolvePairingRequestExpiry } from "../../infra/device-pairing-state.kernel.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "../../infra/device-pairing-worker.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import type { OpenClawIdNodePairingProvenance } from "../../infra/device-pairing.types.js";
import { normalizeNodeApprovalSurfaceList } from "../../infra/node-pairing-surface.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openClawIdNodeDescription,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

/** Approve only a first node-mode device and the declared subset the owner reviewed. */
export async function approveOpenClawIdNodePairing(params: {
  requestId: string;
  principal: OpenClawIdTunnelPrincipal;
  deviceId: string;
  publicKey: string;
  commands: readonly string[];
  caps: readonly string[];
  accessMetadata?: DevicePairingAccessMetadata;
  isCurrent: () => boolean;
}) {
  const { principal } = params;
  const description =
    principal.kind === "node" && principal.authority
      ? openClawIdNodeDescription(principal.peerKey)
      : undefined;
  if (!description || !principal.authority) {
    return null;
  }
  const assertCurrent = () => {
    // Check the live source at transaction and commit, after every broker wait.
    if (!params.isCurrent() || !isOpenClawIdTunnelPrincipalCurrent(principal)) {
      throw new DevicePairingAuthorityRefusedError("OpenClaw ID node authority changed");
    }
  };
  const result = await executeDevicePairingMutation(
    {
      type: "devicePairing.approveOpenClawIdNode",
      input: {
        requestId: params.requestId,
        peerKey: principal.peerKey,
        authority: principal.authority,
        deviceId: params.deviceId,
        publicKey: params.publicKey,
        displayName: description.display_name,
        commands: normalizeNodeApprovalSurfaceList([...params.commands]).filter((command) =>
          description.commands.includes(command),
        ),
        caps: normalizeNodeApprovalSurfaceList([...params.caps]).filter((cap) =>
          description.caps.includes(cap),
        ),
        accessMetadata: params.accessMetadata,
        nowMs: Date.now(),
      },
    },
    {
      assertCurrent,
      onAuthorityRefused: () => null,
      admit: (facts) => {
        if (
          facts.kind === "pairing-approval" &&
          Date.now() > resolvePairingRequestExpiry(facts.pending.refreshedAtMs ?? facts.pending.ts)
        ) {
          throw new DevicePairingAuthorityRefusedError("Node pairing request expired");
        }
      },
    },
  );
  if (result?.status === "approved") {
    publishDevicePairingResolution(
      { requestId: params.requestId, deviceId: params.deviceId },
      "approved",
    );
  }
  return result;
}

/** Idempotently retire peer-granted node roles without deleting suppression or unrelated roles. */
export async function removeNodePairings(peerKeys: readonly string[]): Promise<string[]> {
  return await executeDevicePairingMutation({
    type: "devicePairing.removeOpenClawIdNodes",
    input: { peerKeys, nowMs: Date.now() },
  });
}

/** Reconcile retained role provenance after reset, restart, or interrupted removal effects. */
export async function reconcileNodePairings(
  isCurrent: (source: OpenClawIdNodePairingProvenance) => boolean,
): Promise<string[]> {
  const { paired } = await listDevicePairing();
  const sources = paired.flatMap((device) => {
    const source = device.tokens?.node?.approval;
    return source && !isCurrent(source) ? [source] : [];
  });
  if (sources.length === 0) {
    return [];
  }
  return await executeDevicePairingMutation(
    {
      type: "devicePairing.removeOpenClawIdNodes",
      input: { peerKeys: sources.map((source) => source.peerKey), sources, nowMs: Date.now() },
    },
    {
      assertCurrent: () => {
        if (sources.some(isCurrent)) {
          throw new DevicePairingAuthorityRefusedError(
            "Node listing became current during cleanup",
          );
        }
      },
      onAuthorityRefused: () => [],
    },
  );
}
