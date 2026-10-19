import type { NodePairingGeneration } from "./device-pairing-identity.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";

/** Update remote skill bins while the probe still owns the durable node generation. */
export async function updatePairedNodeBins(
  nodeId: string,
  bins: string[],
  expectedPairingGeneration: NodePairingGeneration,
  baseDir?: string,
  isProbeCurrent?: () => boolean,
): Promise<boolean> {
  return await executeDevicePairingMutation(
    { type: "node.updateBins", input: { nodeId, bins, expectedPairingGeneration } },
    {
      baseDir,
      onAuthorityRefused: () => false,
      assertCurrent: () => {
        if (isProbeCurrent?.() === false) {
          throw new DevicePairingAuthorityRefusedError("node bin check ownership changed");
        }
      },
    },
  );
}

/** Persist runner-host consent only while its connection still owns the durable generation. */
export async function updatePairedNodeSessionHost(params: {
  nodeId: string;
  sessionHost: boolean;
  expectedPairingGeneration: NodePairingGeneration;
  isConnectionCurrent: () => boolean;
  baseDir?: string;
}): Promise<boolean> {
  const { baseDir, isConnectionCurrent, ...input } = params;
  return await executeDevicePairingMutation(
    { type: "node.updateSessionHost", input },
    {
      baseDir,
      onAuthorityRefused: () => false,
      assertCurrent: () => {
        if (!isConnectionCurrent()) {
          throw new DevicePairingAuthorityRefusedError("node session connection changed");
        }
      },
    },
  );
}
