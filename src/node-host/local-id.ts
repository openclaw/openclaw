import { resolveStateDir } from "../config/paths.js";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";

const localNodeIdByStateDir = new Map<string, string | Promise<string | null>>();

// Keep successful primary identity reads process-stable, without creating credentials.
// Misses remain retryable because a node may create its identity after Gateway startup.
export async function resolveLocalNodeId(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const stateDir = resolveStateDir(env);
  const cached = localNodeIdByStateDir.get(stateDir);
  if (cached) {
    return cached;
  }
  // Concurrent catalog providers must not enqueue separate cold identity reads.
  const pending = loadDeviceIdentityIfPresentAsync({ env }).then(
    (identity) => {
      const nodeId = identity?.deviceId ?? null;
      if (nodeId) {
        localNodeIdByStateDir.set(stateDir, nodeId);
      } else {
        localNodeIdByStateDir.delete(stateDir);
      }
      return nodeId;
    },
    (error: unknown) => {
      localNodeIdByStateDir.delete(stateDir);
      throw error;
    },
  );
  localNodeIdByStateDir.set(stateDir, pending);
  return pending;
}
