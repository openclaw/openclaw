import { statSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";

export function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return options.path === undefined
    ? resolveOpenClawStateSqlitePath(options.env ?? process.env)
    : normalizeDatabasePath(path.resolve(options.path));
}

export function existingPathOrUndefined(pathname: string): string | undefined {
  try {
    statSync(pathname);
    return pathname;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** Resolve the directory that contains the shared state SQLite file. */
export function resolveOpenClawStateSqliteDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.dirname(resolveOpenClawStateSqlitePath(env));
}

/** Resolve the shared state SQLite file path. */
export function resolveOpenClawStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeDatabasePath(path.join(resolveStateDir(env), "state", "openclaw.sqlite"));
}

/** Resolve the state owner directory for a canonical or explicit shared database path. */
export function resolveOpenClawStateDirForDatabasePath(databasePath: string): string {
  const databaseDir = path.dirname(path.resolve(databasePath));
  return path.basename(databaseDir) === "state" ? path.dirname(databaseDir) : databaseDir;
}

/** Resolve the integrity/quarantine store that survives loss of the primary state database. */
export function resolveQuarantineStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveOpenClawStateSqliteDir(env), "openclaw-quarantine.sqlite");
}

/** Resolve the durable registry form for one agent database path. */
export function resolveOpenClawAgentDatabaseStoredPath(
  registryDatabasePath: string,
  agentDatabasePath: string,
): string {
  const windows = process.platform === "win32";
  const rawStateDir = resolveOpenClawStateDirForDatabasePath(registryDatabasePath);
  let stateDir = windows ? normalizeWindowsPathPreservingCase(rawStateDir) : rawStateDir;
  const absolutePath =
    windows && path.isAbsolute(agentDatabasePath)
      ? agentDatabasePath
      : path.resolve(agentDatabasePath);
  const comparisonPath = windows ? normalizeWindowsPathPreservingCase(absolutePath) : absolutePath;
  // Device namespaces without a plain drive/share spelling retain their original locator.
  if (!path.isAbsolute(stateDir) || !path.isAbsolute(comparisonPath)) {
    return absolutePath;
  }
  let relativePath = path.relative(stateDir, comparisonPath);
  const useCanonicalRoot =
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    (windows && !isPathInside(rawStateDir, absolutePath));
  // Admit raw Windows locators before compression can erase their share or namespace identity.
  if (useCanonicalRoot) {
    const canonicalRoot = resolveIdentityPathViaExistingAncestorSync(stateDir);
    if (windows && !isPathInside(canonicalRoot, absolutePath)) {
      return absolutePath;
    }
    stateDir = windows ? normalizeWindowsPathPreservingCase(canonicalRoot) : canonicalRoot;
    if (!path.isAbsolute(stateDir)) {
      return absolutePath;
    }
    relativePath = path.relative(stateDir, comparisonPath);
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return absolutePath;
  }
  if (useCanonicalRoot && !windows) {
    return relativePath;
  }
  // Preserve raw traversal tokens after the root; only namespace spelling is an alias.
  const rawPrefix = [stateDir, path.toNamespacedPath(stateDir)]
    .map((root) => `${root}${root.endsWith(path.sep) ? "" : path.sep}`)
    .find((prefix) => agentDatabasePath.startsWith(prefix));
  return path.isAbsolute(agentDatabasePath) && rawPrefix !== undefined
    ? agentDatabasePath.slice(rawPrefix.length)
    : relativePath;
}

/** Resolve one stored agent database registry path for runtime consumers. */
export function resolveOpenClawRegisteredAgentDatabasePath(
  registryDatabasePath: string,
  storedPath: string,
): string {
  return path.isAbsolute(storedPath)
    ? storedPath
    : `${resolveOpenClawStateDirForDatabasePath(registryDatabasePath)}${path.sep}${storedPath}`;
}

type AgentPathMigrationObservation = {
  relativized: number;
  reanchored: string[];
  deleted: string[];
};

type AgentPathMigrationLogger = {
  warn: (
    message: string,
    fields: { reanchored: string[]; deleted: string[]; path: string },
  ) => void;
};

export function describeAgentPathMigration(summary: AgentPathMigrationObservation): string[] {
  const { relativized, reanchored, deleted } = summary;
  if (relativized === 0 && reanchored.length === 0 && deleted.length === 0) {
    return [];
  }
  const decisions = reanchored.length + deleted.length;
  const counts = [
    `${relativized} relativized`,
    reanchored.length > 0 && `${reanchored.length} re-anchored`,
    deleted.length > 0 && `${deleted.length} removed`,
  ].filter(Boolean);
  return [
    `Migrated agent database registry paths to state-relative storage${decisions > 0 ? ` (${counts.join(", ")})` : ""}`,
    ...reanchored.map(
      (registeredPath) =>
        `Re-anchored agent database registry path ${registeredPath} to the current state directory`,
    ),
    ...deleted.map(
      (registeredPath) => `Removed duplicate agent database registry path ${registeredPath}`,
    ),
  ];
}

export function warnAgentPathMigration(
  log: AgentPathMigrationLogger,
  summary: AgentPathMigrationObservation,
  databasePath: string,
): void {
  if (summary.reanchored.length === 0 && summary.deleted.length === 0) {
    return;
  }
  log.warn("agent database registry rows re-anchored or removed during v9 migration", {
    reanchored: summary.reanchored,
    deleted: summary.deleted,
    path: databasePath,
  });
}
