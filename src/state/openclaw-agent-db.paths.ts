// Agent database path helpers resolve per-agent persisted database paths.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { probePathSuffixAliasesSync, resolvePathPrefixSync } from "../infra/fs-safe-advanced.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Path helpers for per-agent SQLite state.
 *
 * Agent databases live beside the shared state database root so each agent can
 * own private runtime tables while the shared registry can still discover them.
 */
/** Inputs for resolving one agent SQLite path or directory. */
type OpenClawAgentSqlitePathOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

export const INCOGNITO_AGENT_SQLITE_BASENAME = "incognito-openclaw-agent.sqlite";

class IncognitoAgentDatabasePathCollisionError extends Error {
  readonly path: string;

  constructor(pathname: string) {
    super(
      `Incognito agent database sentinel path already exists: ${pathname}. This filename is reserved for in-memory incognito state; move or rename the file and retry.`,
    );
    this.name = "IncognitoAgentDatabasePathCollisionError";
    this.path = pathname;
  }
}

export function assertIncognitoAgentDatabasePathAvailable(pathname: string): void {
  if (existsSync(pathname)) {
    throw new IncognitoAgentDatabasePathCollisionError(pathname);
  }
}

const agentSqlitePaths = new Map<string, string>();
// Keep the FIFO cursor so eviction never rescans deleted Map entries.
const agentSqlitePathKeys = agentSqlitePaths.keys();

/** Resolve the SQLite file for one normalized agent id. */
export function resolveOpenClawAgentSqlitePath(options: OpenClawAgentSqlitePathOptions): string {
  const agentId = normalizeAgentId(options.agentId);
  if (options.path != null) {
    return path.resolve(options.path);
  }
  // The state-dir owner still observes env, cwd, and legacy-directory changes.
  // Only its resolved output is memoized; a changed root selects a new entry.
  const stateDir = resolveStateDir(options.env ?? process.env);
  const cacheKey = `${agentId}:${stateDir}`;
  const cached = agentSqlitePaths.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = path.resolve(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  agentSqlitePaths.set(cacheKey, resolved);
  if (agentSqlitePaths.size > 256) {
    const oldest = agentSqlitePathKeys.next();
    if (!oldest.done) {
      agentSqlitePaths.delete(oldest.value);
    }
  }
  return resolved;
}

/** Resolve the lexical sentinel path that keys one agent's process-held incognito database. */
export function resolveIncognitoOpenClawAgentSqlitePath(
  options: Omit<OpenClawAgentSqlitePathOptions, "path">,
): string {
  return path.join(
    path.dirname(resolveOpenClawAgentSqlitePath(options)),
    INCOGNITO_AGENT_SQLITE_BASENAME,
  );
}

/** Identify the reserved incognito sentinel without touching its filesystem path. */
export function isIncognitoOpenClawAgentSqlitePath(
  pathname: string,
  options: Omit<OpenClawAgentSqlitePathOptions, "path">,
): boolean {
  const resolved = path.resolve(pathname);
  return (
    path.basename(resolved) === INCOGNITO_AGENT_SQLITE_BASENAME &&
    resolved === resolveIncognitoOpenClawAgentSqlitePath(options)
  );
}

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
    if (!hasErrnoCode(error, "ENOENT")) {
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
