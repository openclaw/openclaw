import fs from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { isWithinDir } from "@openclaw/fs-safe/path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { resolveAgentsDirFromSessionStorePath } from "../config/sessions/paths.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import { hasErrnoCode } from "./errno.js";
import { existsDir, migrationFileExists, safeReadDir } from "./state-migrations.fs.js";
import type { SessionStoreAliasPlan } from "./state-migrations.types.js";

type SessionStorePathRelationship = "same" | "different" | "unknown";

function resolveSessionStorePathRelationship(
  left: string,
  right: string,
): SessionStorePathRelationship {
  if (left === right) {
    return "same";
  }
  try {
    return sameFileIdentity(
      fs.statSync(left, { bigint: true }),
      fs.statSync(right, { bigint: true }),
    )
      ? "same"
      : "different";
  } catch (err) {
    if (!hasErrnoCode(err, "ENOENT") && !hasErrnoCode(err, "ENOTDIR")) {
      return "unknown";
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    if (resolvedLeft === undefined || resolvedRight === undefined) {
      return "unknown";
    }
    return resolvedLeft === resolvedRight ? "same" : "different";
  }
}

export function sessionStorePathsMatch(left: string, right: string): boolean {
  // Ownership checks must fail closed: an inaccessible path may still alias the
  // readable store, so preserve shared-owner policy until identity is known.
  return resolveSessionStorePathRelationship(left, right) !== "different";
}

function resolvePathThroughExistingParents(filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath);
  const suffix = [path.basename(resolvedPath)];
  let parentPath = path.dirname(resolvedPath);
  while (true) {
    try {
      return path.join(fs.realpathSync.native(parentPath), ...suffix);
    } catch (err) {
      if (!hasErrnoCode(err, "ENOENT") && !hasErrnoCode(err, "ENOTDIR")) {
        return undefined;
      }
      const nextParent = path.dirname(parentPath);
      if (nextParent === parentPath) {
        return undefined;
      }
      suffix.unshift(path.basename(parentPath));
      parentPath = nextParent;
    }
  }
}

function sessionStorePathIsFinalSymlink(storePath: string): boolean {
  try {
    return fs.lstatSync(storePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function sessionStorePathsHaveDistinctEntries(left: string, right: string): boolean {
  if (left === right) {
    return false;
  }
  try {
    // Replacing a final-component symlink splits it from its target. Parent
    // symlink spellings are safe because both names still address one entry.
    if (fs.lstatSync(left).isSymbolicLink() || fs.lstatSync(right).isSymbolicLink()) {
      return true;
    }
    // Hard links resolve to distinct pathnames and split on replacement.
    return fs.realpathSync.native(left) !== fs.realpathSync.native(right);
  } catch (err) {
    if (!hasErrnoCode(err, "ENOENT") && !hasErrnoCode(err, "ENOTDIR")) {
      return true;
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    return resolvedLeft === undefined || resolvedLeft !== resolvedRight;
  }
}

export function resolveSessionStoreAliasPlan(
  storePath: string,
  candidatePaths: Iterable<string>,
): SessionStoreAliasPlan {
  let hasDistinctEntries = false;
  let hasFinalSymlink = sessionStorePathIsFinalSymlink(storePath);
  let hasUnresolvedIdentity = false;
  for (const candidatePath of candidatePaths) {
    const relationship = resolveSessionStorePathRelationship(storePath, candidatePath);
    if (relationship === "different") {
      continue;
    }
    if (relationship === "unknown") {
      hasUnresolvedIdentity = true;
      continue;
    }
    hasFinalSymlink ||= sessionStorePathIsFinalSymlink(candidatePath);
    if (sessionStorePathsHaveDistinctEntries(storePath, candidatePath)) {
      hasDistinctEntries = true;
    }
  }
  return {
    hasDistinctAliases: hasFinalSymlink || hasDistinctEntries || hasUnresolvedIdentity,
    hasFinalSymlink,
    hasUnresolvedIdentity,
  };
}

// Doctor migration must read legacy session stores even before a per-agent
// SQLite DB exists; active runtime discovery remains SQLite-validated.
export function resolveLegacyAcpMetadataSessionStoreTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; storePath: string }> {
  const stateDir = resolveStateDir(env);
  const agentsDirs = new Set<string>([path.join(stateDir, "agents")]);
  const targets = new Map<string, { agentId: string; storePath: string }>();
  const addTarget = (agentId: string, storePath: string) => {
    if (storePath.endsWith(".sqlite") || !isManagedLegacySessionStorePathSafe(storePath)) {
      return;
    }
    const agentsDir = resolveAgentsDirFromSessionStorePath(storePath);
    if (agentsDir) {
      agentsDirs.add(agentsDir);
    }
    if (!targets.has(storePath)) {
      targets.set(storePath, { agentId, storePath });
    }
  };

  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    addTarget(target.agentId, target.storePath);
  }
  for (const target of resolveSessionStoreTargets(cfg, { allAgents: true }, { env })) {
    addTarget(target.agentId, target.storePath);
  }

  for (const agentsDir of agentsDirs) {
    if (!existsDir(agentsDir)) {
      continue;
    }
    for (const entry of safeReadDir(agentsDir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agentId = normalizeAgentId(entry.name);
      const normalizedDirName = normalizeLowercaseStringOrEmpty(entry.name);
      if (agentId === DEFAULT_AGENT_ID && normalizedDirName !== agentId) {
        continue;
      }
      addTarget(agentId, path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  return [...targets.values()];
}

function isManagedLegacySessionStorePathSafe(storePath: string): boolean {
  const resolvedStorePath = path.resolve(storePath);
  const agentsDir = resolveAgentsDirFromSessionStorePath(resolvedStorePath);
  if (!agentsDir) {
    return true;
  }
  if (!migrationFileExists(resolvedStorePath)) {
    return true;
  }

  try {
    const stat = fs.lstatSync(resolvedStorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }
    const resolvedAgentsDir = path.resolve(agentsDir);
    const realStorePath = fs.realpathSync.native(resolvedStorePath);
    const realAgentsDir = fs.realpathSync.native(resolvedAgentsDir);
    return isWithinDir(realAgentsDir, realStorePath);
  } catch {
    return false;
  }
}
