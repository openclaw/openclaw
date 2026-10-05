import path from "node:path";
import type { NodeWorkerWorkspaceSession } from "./node-worker-workspace-identity.js";
import { listOwnedDirectories } from "./node-worker-workspace-retention.js";

const ENVIRONMENT_HASH_PATTERN = /^[a-f0-9]{16}$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{32}$/u;

export async function listNodeWorkerWorkspaceSessions(
  root: string,
  gatewayNamespace: string,
): Promise<NodeWorkerWorkspaceSession[]> {
  const gatewayRoot = path.join(root, gatewayNamespace);
  const workspacesRoot = path.join(gatewayRoot, "workspaces");
  const sessions: NodeWorkerWorkspaceSession[] = [];
  for (const environmentHash of await listOwnedDirectories(workspacesRoot)) {
    if (!ENVIRONMENT_HASH_PATTERN.test(environmentHash)) {
      continue;
    }
    const environmentRoot = path.join(workspacesRoot, environmentHash);
    for (const sessionHash of await listOwnedDirectories(environmentRoot)) {
      if (!SESSION_HASH_PATTERN.test(sessionHash)) {
        continue;
      }
      sessions.push({
        gatewayNamespace,
        environmentHash,
        sessionHash,
        workspacesRoot,
        environmentRoot,
        sessionRoot: path.join(environmentRoot, sessionHash),
      });
    }
  }
  return sessions;
}
