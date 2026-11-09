import fs from "node:fs";
import path from "node:path";
import { isSharedAuthStoreOwner } from "../agents/agent-delete-safety.js";
import {
  listAgentIds,
  resolveDefaultAgentDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  prepareSharedAuthStoreOwnershipForNative as resolveSharedAuthStoreOwnership,
  resolveNativeSharedAuthStorePath as resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.native.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { safeStatSync } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import type { OrphanAgentDir } from "./doctor-state-integrity-format.js";

function tryResolveNativeRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function areComparablePathsEqual(leftPath: string, rightPath: string): boolean {
  const leftRealPath = tryResolveNativeRealPath(leftPath);
  const rightRealPath = tryResolveNativeRealPath(rightPath);
  return leftRealPath !== null && leftRealPath === rightRealPath;
}

function isReachableConfiguredAgentDir(params: {
  agentsRoot: string;
  dirName: string;
  agentId: string;
}): boolean {
  if (params.dirName === params.agentId) {
    return true;
  }
  const rawDir = path.join(params.agentsRoot, params.dirName, "agent");
  const normalizedDir = path.join(params.agentsRoot, params.agentId, "agent");
  return areComparablePathsEqual(rawDir, normalizedDir);
}

export function listOrphanAgentDirs(
  cfg: OpenClawConfig,
  stateDir: string,
  onUnavailable?: (pathname: string, error: unknown) => void,
): OrphanAgentDir[] {
  const configuredIds = new Set(listAgentIds(cfg));
  const sharedAuthOwnership = resolveSharedAuthStoreOwnership();
  const sharedAuthDbPath = resolveSharedAuthStorePath();
  const defaultAgentId = tryResolveDefaultAgentId(cfg);

  const agentsRoot = path.join(stateDir, "agents");
  const liveDefaultAgentDir = defaultAgentId ? resolveDefaultAgentDir(cfg) : undefined;
  try {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    return entries
      .flatMap((entry) => {
        if (!entry.isDirectory()) {
          return [];
        }
        const dirName = entry.name;
        const agentId = normalizeAgentId(dirName);
        const nestedAgentDir = path.join(agentsRoot, dirName, "agent");
        // Reserved system ids own state but cannot appear in the configured roster.
        if (
          !safeStatSync(nestedAgentDir)?.isDirectory() ||
          isReservedSystemAgentId(agentId) ||
          isSharedAuthStoreOwner({
            ownership: sharedAuthOwnership,
            agentAuthDbPath: resolveAuthProfileDatabasePath(nestedAgentDir),
            sharedAuthDbPath,
          }) ||
          (liveDefaultAgentDir && areComparablePathsEqual(nestedAgentDir, liveDefaultAgentDir)) ||
          (configuredIds.has(agentId) &&
            isReachableConfiguredAgentDir({ agentsRoot, dirName, agentId }))
        ) {
          return [];
        }
        return [{ dirName, agentId }];
      })
      .toSorted(
        (left, right) =>
          left.agentId.localeCompare(right.agentId) || left.dirName.localeCompare(right.dirName),
      );
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      onUnavailable?.(agentsRoot, error);
    }
    return [];
  }
}
