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
  try {
    return await executeDevicePairingMutation(
      { type: "node.updateBins", input: { nodeId, bins, expectedPairingGeneration } },
      {
        baseDir,
        assertCurrent: () => {
          if (isProbeCurrent?.() === false) {
            throw new DevicePairingAuthorityRefusedError("node bin probe ownership changed");
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof DevicePairingAuthorityRefusedError) {
      return false;
    }
    throw error;
  }
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
  try {
    return await executeDevicePairingMutation(
      { type: "node.updateSessionHost", input },
      {
        baseDir,
        assertCurrent: () => {
          if (!isConnectionCurrent()) {
            throw new DevicePairingAuthorityRefusedError("node session connection changed");
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof DevicePairingAuthorityRefusedError) {
      return false;
    }
    throw error;
  }
}
