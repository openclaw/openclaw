import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import type { NodeWorkerWorkspaceSession } from "./node-worker-workspace-identity.js";

const ENVIRONMENT_HASH_PATTERN = /^[a-f0-9]{16}$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{32}$/u;

export async function listOwnedEntries(parent: string): Promise<fs.Dirent[]> {
  try {
    return (await fsp.readdir(parent, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

export async function listOwnedDirectories(parent: string): Promise<string[]> {
  return (await listOwnedEntries(parent))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function removeIfEmpty(target: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await fsp.rmdir(target);
  } catch (error) {
    if (
      !hasNodeErrorCode(error, "ENOENT") &&
      !hasNodeErrorCode(error, "ENOTEMPTY") &&
      !hasNodeErrorCode(error, "EEXIST")
    ) {
      throw error;
    }
  }
}

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
