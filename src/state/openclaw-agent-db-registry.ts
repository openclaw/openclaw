import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { probePathSuffixAliasesSync, resolvePathPrefixSync } from "../infra/fs-safe-advanced.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import { invalidateRegisteredAgentDatabasesMemo } from "./openclaw-agent-db-registry-listing.js";
import {
  invalidateOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidationsForAgent,
} from "./openclaw-agent-db-validation-cache.js";
import { requireOpenClawStateDatabaseIdentity } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";

export {
  inspectOpenClawRegisteredAgentDatabases,
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry-listing.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

type AgentDatabasePathIdentity = {
  lexicalPath: string;
  realPath?: string;
  device?: bigint | number;
  inode?: bigint | number;
  parentDevice?: bigint | number;
  parentInode?: bigint | number;
  parentRealPath?: string;
  unresolvedSuffix?: string;
};

const missingSuffixAliasCache = new Map<string, boolean>();

function shouldProbeUnicodeCaseVariants(left: string, right: string): boolean {
  const hasNonAscii = (value: string) =>
    value.split("").some((character) => character.charCodeAt(0) > 0x7f);
  if (!hasNonAscii(left) && !hasNonAscii(right)) {
    return false;
  }
  const lowercaseEquivalent = left.toLowerCase() === right.toLowerCase();
  const uppercaseEquivalent = left.toUpperCase() === right.toUpperCase();
  if (!lowercaseEquivalent && !uppercaseEquivalent) {
    return false;
  }
  // Keep dotted-I expansions distinct even on filesystems that collapse them.
  // That existing isolation contract avoids locale-sensitive owner aliasing.
  return !(
    Array.from(left).length !== Array.from(right).length &&
    lowercaseEquivalent &&
    !uppercaseEquivalent
  );
}

function areMissingSuffixAliases(params: {
  left: string | undefined;
  right: string | undefined;
  parentDevice: bigint | number;
  parentInode: bigint | number;
  parentRealPath: string;
}): boolean {
  if (params.left === undefined || params.right === undefined) {
    return false;
  }
  if (params.left === params.right) {
    return true;
  }
  const leftSegments = params.left.split(path.sep);
  const rightSegments = params.right.split(path.sep);
  if (
    leftSegments.length !== rightSegments.length ||
    [...leftSegments, ...rightSegments].some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    return false;
  }
  const suffixPair = [params.left, params.right].toSorted();
  const cacheKey = JSON.stringify([
    params.parentDevice.toString(),
    params.parentInode.toString(),
    params.parentRealPath,
    ...suffixPair,
  ]);
  const cached = missingSuffixAliasCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let aliases: boolean | undefined;
  let cause: unknown;
  try {
    aliases = probePathSuffixAliasesSync({
      directory: params.parentRealPath,
      left: params.left,
      right: params.right,
      maxDepth: leftSegments.length,
      shouldProbeCaseVariants: shouldProbeUnicodeCaseVariants,
    });
  } catch (error) {
    cause = error;
  }
  if (aliases === undefined) {
    throw new Error(
      `Cannot determine whether database paths alias under ${JSON.stringify(params.parentRealPath)}: ${JSON.stringify(params.left)} and ${JSON.stringify(params.right)}. Check directory access and retry.`,
      { cause },
    );
  }
  // A comparison becomes reusable only after every owned probe was removed.
  missingSuffixAliasCache.set(cacheKey, aliases);
  return aliases;
}

function anchorDatabasePathWithoutNormalizing(pathname: string): string {
  const platformPath = path.sep === "\\" ? pathname.replaceAll("/", "\\") : pathname;
  if (path.isAbsolute(platformPath)) {
    return platformPath;
  }
  if (path.sep === "\\") {
    const driveRelative = /^([A-Za-z]:)(.*)$/u.exec(platformPath);
    if (driveRelative) {
      // Resolve only the drive's current-directory anchor. Appending the raw
      // suffix preserves `..` for the component-wise filesystem walk below.
      const driveBase = path.resolve(`${driveRelative[1]}.`);
      return driveRelative[2]
        ? `${driveBase}${driveBase.endsWith(path.sep) ? "" : path.sep}${driveRelative[2]}`
        : driveBase;
    }
  }
  const cwd = process.cwd();
  return `${cwd}${cwd.endsWith(path.sep) ? "" : path.sep}${platformPath}`;
}

function resolveAgentDatabasePathIdentity(pathname: string): AgentDatabasePathIdentity {
  // `path.resolve` collapses `..` before symlinks are inspected, but the filesystem
  // resolves `link/..` from the link target. Anchor relative input without rewriting tokens.
  const lexicalPath = anchorDatabasePathWithoutNormalizing(pathname);
  try {
    const realPath = realpathSync.native(lexicalPath);
    const stat = statSync(realPath, { bigint: true });
    return {
      lexicalPath,
      realPath,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Registry locators ignore input separator runs; expanded symlink targets
    // retain raw missing suffixes, including `missing/../live.sqlite`.
    const rootPath = path.parse(lexicalPath).root;
    const observed = resolvePathPrefixSync(
      rootPath + lexicalPath.slice(rootPath.length).split(path.sep).filter(Boolean).join(path.sep),
    );
    const parentRealPath = observed.existingPath;
    const parentStat = statSync(parentRealPath, { bigint: true });
    return {
      lexicalPath,
      parentDevice: parentStat.dev,
      parentInode: parentStat.ino,
      parentRealPath,
      unresolvedSuffix: observed.unresolvedSegments.join(path.sep),
    };
  }
}

function areSameAgentDatabasePathIdentities(
  leftIdentity: AgentDatabasePathIdentity,
  rightIdentity: AgentDatabasePathIdentity,
): boolean {
  if (leftIdentity.lexicalPath === rightIdentity.lexicalPath) {
    return true;
  }
  if (leftIdentity.realPath && leftIdentity.realPath === rightIdentity.realPath) {
    return true;
  }
  const parentDevice = leftIdentity.parentDevice;
  const parentInode = leftIdentity.parentInode;
  const sameMissingParent =
    parentDevice !== undefined &&
    parentInode !== undefined &&
    parentDevice === rightIdentity.parentDevice &&
    parentInode === rightIdentity.parentInode;
  const sameMissingSuffix =
    leftIdentity.unresolvedSuffix === rightIdentity.unresolvedSuffix ||
    (sameMissingParent &&
      parentDevice !== undefined &&
      parentInode !== undefined &&
      leftIdentity.parentRealPath !== undefined &&
      areMissingSuffixAliases({
        left: leftIdentity.unresolvedSuffix,
        right: rightIdentity.unresolvedSuffix,
        parentDevice,
        parentInode,
        parentRealPath: leftIdentity.parentRealPath,
      }));
  return (
    (leftIdentity.device !== undefined &&
      leftIdentity.inode !== undefined &&
      leftIdentity.device === rightIdentity.device &&
      leftIdentity.inode === rightIdentity.inode) ||
    (sameMissingParent && sameMissingSuffix)
  );
}

/** Create a synchronous-operation matcher that prepares each exact locator once. */
export function createOpenClawAgentDatabasePathMatcher(): {
  (left: string, right: string): boolean;
  isCurrent(): boolean;
} {
  const identities = new Map<string, AgentDatabasePathIdentity>();
  const resolveIdentity = (pathname: string): AgentDatabasePathIdentity => {
    const lexicalPath = anchorDatabasePathWithoutNormalizing(pathname);
    const cached = identities.get(lexicalPath);
    if (cached) {
      return cached;
    }
    // Cache successes only. Filesystem errors must be retried if the caller recovers.
    const identity = resolveAgentDatabasePathIdentity(lexicalPath);
    identities.set(lexicalPath, identity);
    return identity;
  };
  return Object.assign(
    (left: string, right: string) =>
      areSameAgentDatabasePathIdentities(resolveIdentity(left), resolveIdentity(right)),
    {
      isCurrent() {
        for (const previous of identities.values()) {
          const current = resolveAgentDatabasePathIdentity(previous.lexicalPath);
          // Equal locators alone cannot validate a snapshot after replacement.
          if (
            previous.realPath !== current.realPath ||
            previous.device !== current.device ||
            previous.inode !== current.inode ||
            previous.parentDevice !== current.parentDevice ||
            previous.parentInode !== current.parentInode ||
            previous.parentRealPath !== current.parentRealPath ||
            previous.unresolvedSuffix !== current.unresolvedSuffix
          ) {
            return false;
          }
        }
        return true;
      },
    },
  );
}

/** Compare two database locators by canonical filesystem identity when available. */
export function isSameOpenClawAgentDatabasePath(left: string, right: string): boolean {
  return areSameAgentDatabasePathIdentities(
    resolveAgentDatabasePathIdentity(left),
    resolveAgentDatabasePathIdentity(right),
  );
}

export function registerOpenClawAgentDatabase(
  params: {
    agentId: string;
    path: string;
    env?: NodeJS.ProcessEnv;
    schemaVersion?: number;
  },
  onCommitted?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
): void {
  if (!isPersistentOpenClawAgentDatabasePath(params.path, params.env)) {
    return;
  }
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId: params.agentId, path: params.path },
    { env: params.env },
  );
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      assertAgentDeletionPathFence(database, deletionFence);
      const storedPath = resolveOpenClawAgentDatabaseStoredPath(database.path, params.path);
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: storedPath,
            schema_version: params.schemaVersion ?? OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              schema_version: params.schemaVersion ?? OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
      invalidateRegisteredAgentDatabasesMemo({ env: params.env });
      if (onCommitted) {
        const receipt = Object.freeze({
          agentId: params.agentId,
          agentPath: params.path,
          stateDatabasePath: database.path,
          stateDatabaseIdentity: requireOpenClawStateDatabaseIdentity(database).key,
        });
        // Record the native fact before fallible observers; the recorder never performs work.
        if (
          !stageSqliteTransactionState(database.db, {
            stage() {},
            rollback() {},
            commit: () => onCommitted(receipt),
          })
        ) {
          throw new Error(
            "Agent registration requires its canonical transaction publication scope",
          );
        }
      }
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    },
    { env: params.env },
  );
  invalidateOpenClawAgentDatabaseValidation(params.path);
}

function canonicalPathForRegistryBoundary(pathname: string): string {
  const identity = resolveAgentDatabasePathIdentity(pathname);
  if (identity.realPath) {
    return identity.realPath;
  }
  if (!identity.parentRealPath || !identity.unresolvedSuffix) {
    return identity.parentRealPath ?? path.resolve(pathname);
  }
  const unresolvedSegments = identity.unresolvedSuffix.split(path.sep);
  return unresolvedSegments.includes("..")
    ? identity.parentRealPath
    : path.join(identity.parentRealPath, ...unresolvedSegments);
}

/** Named import artifacts are offline archives, not durable runtime discovery state. */
export function isPersistentOpenClawAgentDatabasePath(
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const lexicalCandidate = path.resolve(pathname);
  const lexicalImportsDir = path.join(path.resolve(resolveStateDir(env)), "imports");
  if (lexicalCandidate === lexicalImportsDir || isPathInside(lexicalImportsDir, lexicalCandidate)) {
    return false;
  }
  const candidate = canonicalPathForRegistryBoundary(pathname);
  const stateDir = canonicalPathForRegistryBoundary(resolveStateDir(env));
  const importsDir = canonicalPathForRegistryBoundary(path.join(stateDir, "imports"));
  if (candidate === importsDir || isPathInside(importsDir, candidate)) {
    return false;
  }
  return true;
}

export function unregisterOpenClawAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const storedPath = resolveOpenClawAgentDatabaseStoredPath(database.path, params.path);
      const matchingPaths = [...new Set([storedPath, params.path, path.resolve(params.path)])];
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("agent_databases")
          .where("agent_id", "=", params.agentId)
          .where("path", "in", matchingPaths),
      );
      invalidateRegisteredAgentDatabasesMemo({ env: params.env });
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    },
    { env: params.env },
  );
  invalidateOpenClawAgentDatabaseValidation(params.path);
}

/** Remove every durable database registration owned by a deleted agent. */
export function unregisterOpenClawAgentDatabases(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  database?: OpenClawStateDatabase;
}): void {
  const options = {
    env: params.env,
    ...(params.database ? { database: params.database, path: params.database.path } : {}),
  };
  const removedPaths = runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
    const removed = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("agent_databases").where("agent_id", "=", params.agentId).returning("path"),
    );
    invalidateRegisteredAgentDatabasesMemo(options);
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    return removed.rows.map((row) =>
      resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path),
    );
  }, options);
  invalidateOpenClawAgentDatabaseValidationsForAgent(params.agentId, removedPaths);
}
