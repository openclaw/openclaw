import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sameFileIdentity } from "../../infra/file-identity.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { createConfigIO } from "../io.js";
import { resolveStateDir } from "../paths.js";

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fs.constants;
const OPEN_DIRECTORY_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0) |
  (SUPPORTS_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);

type PathIdentitySnapshot = {
  path: string;
  stat: fs.Stats;
};

type PinnedStateRootIdentity = {
  path: string;
  stat: fs.Stats;
  strictDirectoryIdentity: boolean;
  targetPath?: string;
  targetStat?: fs.Stats;
};

const QUIET_CONFIG_IO_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const AGENT_ID_TEMPLATE_SENTINEL = "__openclaw_agent_id__";

function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

function resolveManagedSessionsSafetyChain(sessionsDir: string): string[] {
  const resolved = path.resolve(sessionsDir);
  const agentDir = path.dirname(resolved);
  const agentsDir = path.dirname(agentDir);
  if (
    path.basename(resolved).toLowerCase() === "sessions" &&
    path.basename(agentsDir).toLowerCase() === "agents"
  ) {
    // The configured state root itself may be a user-chosen symlink alias.
    // We only reject symlinks inside the managed agents/<id>/sessions chain.
    return [agentsDir, agentDir, resolved];
  }
  return [path.dirname(resolved), resolved];
}

async function capturePinnedDirectoryIdentity(
  dirPath: string,
  opts?: { allowSymlinkAlias?: boolean },
): Promise<PinnedStateRootIdentity> {
  if (opts?.allowSymlinkAlias) {
    const stat = await fsPromises.lstat(dirPath);
    if (stat.isSymbolicLink()) {
      const pinnedIdentity = await capturePinnedStateRootIdentity(dirPath);
      if (pinnedIdentity) {
        return pinnedIdentity;
      }
    }
  }

  return {
    path: dirPath,
    stat: await verifyDirectoryIdentity(dirPath),
    strictDirectoryIdentity: true,
  };
}

async function ensureStrictDirectoryChain(
  targetDir: string,
  opts?: { allowAnchorSymlinkAlias?: boolean },
): Promise<PinnedStateRootIdentity> {
  const resolved = path.resolve(targetDir);
  const pendingDirs: string[] = [];
  let anchorDir = resolved;

  while (true) {
    try {
      const pinnedIdentity = await capturePinnedDirectoryIdentity(anchorDir, {
        allowSymlinkAlias: opts?.allowAnchorSymlinkAlias,
      });

      for (const dirPath of pendingDirs.toReversed()) {
        await assertPinnedStateRootIdentity(pinnedIdentity);
        try {
          await verifyDirectoryIdentity(dirPath);
          await assertPinnedStateRootIdentity(pinnedIdentity);
          continue;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            throw err;
          }
        }

        try {
          await fsPromises.mkdir(dirPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") {
            throw err;
          }
        }
        await assertPinnedStateRootIdentity(pinnedIdentity);
        await verifyDirectoryIdentity(dirPath);
        await assertPinnedStateRootIdentity(pinnedIdentity);
      }

      return pinnedIdentity;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    const parent = path.dirname(anchorDir);
    if (parent === anchorDir) {
      throw new Error(`Session transcripts dir must be a directory: ${resolved}`);
    }
    pendingDirs.push(anchorDir);
    anchorDir = parent;
  }
}

async function ensureManagedSessionsParentChain(
  sessionsDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): Promise<PinnedStateRootIdentity | undefined> {
  const resolved = path.resolve(sessionsDir);
  const agentDir = path.dirname(resolved);
  const agentsDir = path.dirname(agentDir);
  if (
    path.basename(resolved).toLowerCase() === "sessions" &&
    path.basename(agentsDir).toLowerCase() === "agents"
  ) {
    const stateDir = path.dirname(agentsDir);
    let pinnedStateRootIdentity: PinnedStateRootIdentity | undefined;
    try {
      const stat = await fsPromises.stat(stateDir);
      if (!stat.isDirectory()) {
        throw new Error(`Session transcripts dir must be a directory: ${stateDir}`);
      }
      pinnedStateRootIdentity = await capturePinnedStateRootIdentity(stateDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw err;
      }
      await fsPromises.mkdir(stateDir, { recursive: true });
      pinnedStateRootIdentity = {
        path: stateDir,
        stat: await verifyDirectoryIdentity(stateDir),
        strictDirectoryIdentity: true,
      };
    }

    for (const dirPath of [agentsDir, agentDir]) {
      await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
      try {
        await verifyDirectoryIdentity(dirPath);
        await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
        continue;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw err;
        }
      }

      try {
        await fsPromises.mkdir(dirPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
      }
      await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
      await verifyDirectoryIdentity(dirPath);
      await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
    }

    return pinnedStateRootIdentity;
  }

  const configuredManagedSessionsDir = resolveConfiguredManagedSessionsDirCandidate(
    resolved,
    env,
    homedir,
  );
  if (
    configuredManagedSessionsDir &&
    matchesManagedSessionsDirCandidate(resolved, configuredManagedSessionsDir)
  ) {
    return await ensureStrictDirectoryChain(path.dirname(resolved), {
      allowAnchorSymlinkAlias: true,
    });
  }

  return undefined;
}

async function verifyDirectoryIdentity(dirPath: string): Promise<fs.Stats> {
  const stat = await fsPromises.lstat(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Session transcripts dir must not traverse a symlink: ${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Session transcripts dir must be a directory: ${dirPath}`);
  }
  if (!SUPPORTS_NOFOLLOW) {
    return stat;
  }

  const handle = await fsPromises.open(dirPath, OPEN_DIRECTORY_FLAGS);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory()) {
      throw new Error(`Session transcripts dir must be a directory: ${dirPath}`);
    }
    if (!sameFileIdentity(stat, openedStat)) {
      throw new Error(`Session transcripts dir changed during permission update: ${dirPath}`);
    }
    return stat;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function capturePinnedStateRootIdentity(
  stateDir: string,
): Promise<PinnedStateRootIdentity | undefined> {
  const stat = await fsPromises.lstat(stateDir);
  if (stat.isSymbolicLink()) {
    // The configured state root may intentionally be a symlink alias.
    const targetPath = await fsPromises.realpath(stateDir);
    return {
      path: stateDir,
      stat,
      strictDirectoryIdentity: false,
      targetPath,
      targetStat: await verifyDirectoryIdentity(targetPath),
    };
  }
  if (!stat.isDirectory()) {
    throw new Error(`Session transcripts dir must be a directory: ${stateDir}`);
  }
  return {
    path: stateDir,
    stat: await verifyDirectoryIdentity(stateDir),
    strictDirectoryIdentity: true,
  };
}

async function assertPinnedStateRootIdentity(
  pinned: PinnedStateRootIdentity | undefined,
): Promise<void> {
  if (!pinned) {
    return;
  }

  const current = pinned.strictDirectoryIdentity
    ? await verifyDirectoryIdentity(pinned.path)
    : await fsPromises.lstat(pinned.path);

  if (!sameFileIdentity(pinned.stat, current)) {
    throw new Error(`Session transcripts dir changed during permission update: ${pinned.path}`);
  }

  if (pinned.targetPath && pinned.targetStat) {
    const currentTarget = await verifyDirectoryIdentity(pinned.targetPath);
    if (!sameFileIdentity(pinned.targetStat, currentTarget)) {
      throw new Error(`Session transcripts dir changed during permission update: ${pinned.path}`);
    }
  }
}

async function snapshotManagedSessionsSafetyChain(
  sessionsDir: string,
  opts: { allowMissingTail: boolean },
): Promise<PathIdentitySnapshot[]> {
  const chain = resolveManagedSessionsSafetyChain(sessionsDir);
  const snapshots: PathIdentitySnapshot[] = [];
  for (const entry of chain) {
    try {
      const stat = await verifyDirectoryIdentity(entry);
      snapshots.push({ path: entry, stat });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (opts.allowMissingTail && code === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
  return snapshots;
}

function assertStablePathIdentities(
  expected: PathIdentitySnapshot[],
  actual: PathIdentitySnapshot[],
): void {
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry.stat]));
  for (const entry of expected) {
    const current = actualByPath.get(entry.path);
    if (!current || !sameFileIdentity(entry.stat, current)) {
      throw new Error(`Session transcripts dir changed during permission update: ${entry.path}`);
    }
  }
}

function shouldIgnorePrivateSessionsChmodError(err: unknown): boolean {
  if (process.platform === "win32") {
    return true;
  }

  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EINVAL";
}

async function applyPrivateSessionsMode(
  resolved: string,
  handle?: fsPromises.FileHandle,
): Promise<void> {
  try {
    if (handle) {
      await handle.chmod(0o700);
    } else {
      await fsPromises.chmod(resolved, 0o700);
    }
  } catch (err) {
    if (shouldIgnorePrivateSessionsChmodError(err)) {
      return;
    }
    throw err;
  }
}

export async function ensurePrivateSessionsDir(sessionsDir: string): Promise<string> {
  const resolved = path.resolve(sessionsDir);
  const pinnedStateRootIdentity = await ensureManagedSessionsParentChain(resolved);
  await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
  const ancestorSnapshots = await snapshotManagedSessionsSafetyChain(resolved, {
    allowMissingTail: true,
  });
  await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
  try {
    const stat = await fsPromises.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Session transcripts dir must not be a symlink: ${resolved}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
  await fsPromises.mkdir(resolved, { recursive: true, mode: 0o700 });
  await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
  const currentAncestorSnapshots = await snapshotManagedSessionsSafetyChain(resolved, {
    allowMissingTail: false,
  });
  assertStablePathIdentities(ancestorSnapshots, currentAncestorSnapshots);
  await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
  const stat = await fsPromises.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`Session transcripts dir must not be a symlink: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Session transcripts dir must be a directory: ${resolved}`);
  }

  if (SUPPORTS_NOFOLLOW) {
    const handle = await fsPromises.open(resolved, OPEN_DIRECTORY_FLAGS);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isDirectory()) {
        throw new Error(`Session transcripts dir must be a directory: ${resolved}`);
      }
      const finalAncestorSnapshots = await snapshotManagedSessionsSafetyChain(resolved, {
        allowMissingTail: false,
      });
      assertStablePathIdentities(currentAncestorSnapshots, finalAncestorSnapshots);
      await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
      const currentStat = await fsPromises.lstat(resolved);
      if (!sameFileIdentity(stat, openedStat) || !sameFileIdentity(currentStat, openedStat)) {
        throw new Error(`Session transcripts dir changed during permission update: ${resolved}`);
      }
      await applyPrivateSessionsMode(resolved, handle);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return resolved;
  }

  await assertPinnedStateRootIdentity(pinnedStateRootIdentity);
  await applyPrivateSessionsMode(resolved);
  return resolved;
}

export async function ensureSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): Promise<string> {
  const sessionsDir = resolveAgentSessionsDir(agentId, env, homedir);
  return await ensurePrivateSessionsDir(sessionsDir);
}

export function resolveSessionStoreDirForAgent(
  agentId?: string,
  opts?: {
    store?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const env = opts?.env ?? process.env;
  const homedir = opts?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir));
  return path.dirname(resolveStorePath(opts?.store, { agentId, env, homedir }));
}

export async function ensureSessionStoreDirForAgent(
  agentId?: string,
  opts?: {
    store?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): Promise<string> {
  const env = opts?.env ?? process.env;
  const homedir = opts?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir));
  const storePath = resolveStorePath(opts?.store, {
    agentId,
    env,
    homedir,
  });
  const sessionsDir = path.dirname(storePath);
  const explicitStoreTemplate = opts?.store?.trim();
  const hasExplicitPerAgentDirTemplate =
    !!explicitStoreTemplate &&
    explicitStoreTemplate.includes("{agentId}") &&
    path.dirname(explicitStoreTemplate).includes("{agentId}");
  if (hasExplicitPerAgentDirTemplate || isManagedSessionStorePath(storePath, env, homedir)) {
    return await ensurePrivateSessionsDir(sessionsDir);
  }
  await fsPromises.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

export async function ensureSessionDirForFile(
  sessionFile: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): Promise<string> {
  const sessionDir = path.dirname(path.resolve(sessionFile));
  if (isManagedSessionsDir(sessionDir, env, homedir)) {
    return await ensurePrivateSessionsDir(sessionDir);
  }
  await fsPromises.mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

export function isManagedSessionsDir(
  sessionsDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): boolean {
  const resolvedSessionsDir = path.resolve(sessionsDir);
  const defaultManagedSessionsDir = resolveDefaultManagedSessionsDirCandidate(
    resolvedSessionsDir,
    env,
    homedir,
  );
  if (
    defaultManagedSessionsDir &&
    matchesManagedSessionsDirCandidate(resolvedSessionsDir, defaultManagedSessionsDir)
  ) {
    return true;
  }

  const configuredManagedSessionsDir = resolveConfiguredManagedSessionsDirCandidate(
    resolvedSessionsDir,
    env,
    homedir,
  );
  return (
    !!configuredManagedSessionsDir &&
    matchesManagedSessionsDirCandidate(resolvedSessionsDir, configuredManagedSessionsDir)
  );
}

export function isManagedSessionStorePath(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): boolean {
  const resolvedStorePath = path.resolve(storePath);
  return isManagedSessionsDir(path.dirname(resolvedStorePath), env, homedir);
}

export function isManagedSessionTranscriptPath(
  sessionFile: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): boolean {
  const resolvedSessionFile = path.resolve(sessionFile);
  const fileName = path.basename(resolvedSessionFile);
  if (!fileName || !fileName.endsWith(".jsonl")) {
    return false;
  }
  return isManagedSessionsDir(path.dirname(resolvedSessionFile), env, homedir);
}

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(agentId, env, homedir);
}

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

export type SessionFilePathOptions = {
  agentId?: string;
  sessionsDir?: string;
};

const MULTI_STORE_PATH_SENTINEL = "(multiple)";

export function resolveSessionFilePathOptions(params: {
  agentId?: string;
  storePath?: string;
}): SessionFilePathOptions | undefined {
  const agentId = params.agentId?.trim();
  const storePath = params.storePath?.trim();
  if (storePath && storePath !== MULTI_STORE_PATH_SENTINEL) {
    const sessionsDir = path.dirname(path.resolve(storePath));
    return agentId ? { sessionsDir, agentId } : { sessionsDir };
  }
  if (agentId) {
    return { agentId };
  }
  return undefined;
}

export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!SAFE_SESSION_ID_RE.test(trimmed)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

function resolveSessionsDir(opts?: SessionFilePathOptions): string {
  const sessionsDir = opts?.sessionsDir?.trim();
  if (sessionsDir) {
    return path.resolve(sessionsDir);
  }
  return resolveAgentSessionsDir(opts?.agentId);
}

function resolvePathFromAgentSessionsDir(
  agentSessionsDir: string,
  candidateAbsPath: string,
): string | undefined {
  const agentBase =
    safeRealpathSync(path.resolve(agentSessionsDir)) ?? path.resolve(agentSessionsDir);
  const realCandidate = safeRealpathSync(candidateAbsPath) ?? candidateAbsPath;
  const relative = path.relative(agentBase, realCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return path.resolve(agentBase, relative);
}

function resolveSiblingAgentSessionsDir(
  baseSessionsDir: string,
  agentId: string,
): string | undefined {
  const resolvedBase = path.resolve(baseSessionsDir);
  if (path.basename(resolvedBase) !== "sessions") {
    return undefined;
  }
  const baseAgentDir = path.dirname(resolvedBase);
  const baseAgentsDir = path.dirname(baseAgentDir);
  if (path.basename(baseAgentsDir) !== "agents") {
    return undefined;
  }
  const rootDir = path.dirname(baseAgentsDir);
  return path.join(rootDir, "agents", normalizeAgentId(agentId), "sessions");
}

function resolveAgentSessionsPathParts(
  candidateAbsPath: string,
): { parts: string[]; sessionsIndex: number } | null {
  const normalized = path.normalize(path.resolve(candidateAbsPath));
  const parts = normalized.split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
    return null;
  }
  return { parts, sessionsIndex };
}

function extractAgentIdFromAbsoluteSessionPath(candidateAbsPath: string): string | undefined {
  const parsed = resolveAgentSessionsPathParts(candidateAbsPath);
  if (!parsed) {
    return undefined;
  }
  const { parts, sessionsIndex } = parsed;
  const agentId = parts[sessionsIndex - 1];
  return agentId || undefined;
}

function resolveStructuralSessionFallbackPath(
  candidateAbsPath: string,
  expectedAgentId: string,
): string | undefined {
  const parsed = resolveAgentSessionsPathParts(candidateAbsPath);
  if (!parsed) {
    return undefined;
  }
  const { parts, sessionsIndex } = parsed;
  const agentIdPart = parts[sessionsIndex - 1];
  if (!agentIdPart) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentIdPart);
  if (normalizedAgentId !== agentIdPart.toLowerCase()) {
    return undefined;
  }
  if (normalizedAgentId !== normalizeAgentId(expectedAgentId)) {
    return undefined;
  }
  const relativeSegments = parts.slice(sessionsIndex + 1);
  // Session transcripts are stored as direct files in "sessions/".
  if (relativeSegments.length !== 1) {
    return undefined;
  }
  const fileName = relativeSegments[0];
  if (!fileName || fileName === "." || fileName === "..") {
    return undefined;
  }
  return path.normalize(path.resolve(candidateAbsPath));
}

function safeRealpathSync(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function resolveComparableManagedPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const pendingSegments: string[] = [];
  let cursor = resolved;
  while (true) {
    const real = safeRealpathSync(cursor);
    if (real) {
      // Canonicalize any existing prefix so symlink aliases still compare as the same managed path.
      return path.resolve(real, ...pendingSegments.toReversed());
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return resolved;
    }
    pendingSegments.push(path.basename(cursor));
    cursor = parent;
  }
}

function managedPathSegmentMatches(
  actual: string,
  expected: string,
  compareCaseInsensitively: boolean,
): boolean {
  return compareCaseInsensitively ? actual.toLowerCase() === expected : actual === expected;
}

function resolveManagedPathCaseProbePath(filePath: string): string | undefined {
  let cursor = path.resolve(filePath);
  while (true) {
    if (safeRealpathSync(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

function resolveCaseVariantProbePath(filePath: string): string | undefined {
  const baseName = path.basename(filePath);
  if (!baseName) {
    return undefined;
  }

  const lower = baseName.toLowerCase();
  if (lower !== baseName) {
    return path.join(path.dirname(filePath), lower);
  }

  const upper = baseName.toUpperCase();
  if (upper !== baseName) {
    return path.join(path.dirname(filePath), upper);
  }

  return undefined;
}

function safeLstatSync(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return undefined;
  }
}

function pathsReferenceSameEntry(leftPath: string, rightPath: string): boolean {
  const left = safeLstatSync(leftPath);
  const right = safeLstatSync(rightPath);
  return !!left && !!right && sameFileIdentity(left, right);
}

function shouldCompareManagedPathsCaseInsensitively(filePath: string): boolean {
  if (process.platform === "win32") {
    return true;
  }

  const probePath = resolveManagedPathCaseProbePath(filePath);
  if (!probePath) {
    return false;
  }

  const caseVariantProbePath = resolveCaseVariantProbePath(probePath);
  if (!caseVariantProbePath) {
    return false;
  }

  return pathsReferenceSameEntry(probePath, caseVariantProbePath);
}

function normalizeManagedPathForComparison(
  filePath: string,
  compareCaseInsensitively: boolean,
): string {
  return compareCaseInsensitively ? filePath.toLowerCase() : filePath;
}

function matchesManagedSessionsDirCandidate(
  sessionsDir: string,
  expectedSessionsDir: string,
): boolean {
  const compareCaseInsensitively = shouldCompareManagedPathsCaseInsensitively(expectedSessionsDir);
  return (
    normalizeManagedPathForComparison(
      resolveComparableManagedPath(sessionsDir),
      compareCaseInsensitively,
    ) ===
    normalizeManagedPathForComparison(
      resolveComparableManagedPath(expectedSessionsDir),
      compareCaseInsensitively,
    )
  );
}

function resolveDefaultManagedSessionsDirCandidate(
  sessionsDir: string,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string | undefined {
  const resolvedSessionsDir = path.resolve(sessionsDir);
  const agentDir = path.dirname(resolvedSessionsDir);
  const agentId = path.basename(agentDir);
  if (!agentId) {
    return undefined;
  }

  const expectedSessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, homedir);
  const compareCaseInsensitively = shouldCompareManagedPathsCaseInsensitively(expectedSessionsDir);
  if (
    !managedPathSegmentMatches(
      path.basename(resolvedSessionsDir),
      "sessions",
      compareCaseInsensitively,
    )
  ) {
    return undefined;
  }

  const agentsDir = path.dirname(agentDir);
  if (!managedPathSegmentMatches(path.basename(agentsDir), "agents", compareCaseInsensitively)) {
    return undefined;
  }
  return expectedSessionsDir;
}

function resolveConfiguredManagedSessionsDirCandidate(
  sessionsDir: string,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string | undefined {
  const storeTemplate = loadManagedSessionStoreTemplate(env, homedir);
  if (!storeTemplate) {
    return undefined;
  }

  const configuredSessionsDirTemplate = path.dirname(storeTemplate);
  const extractedAgentId = extractAgentIdFromConfiguredSessionsTemplate(
    path.resolve(sessionsDir),
    configuredSessionsDirTemplate,
  );
  if (!extractedAgentId) {
    return undefined;
  }

  return path.dirname(
    resolveStorePath(storeTemplate, {
      agentId: normalizeAgentId(extractedAgentId),
      env,
    }),
  );
}

function loadManagedSessionStoreTemplate(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string | undefined {
  let configuredStore: string | undefined;
  try {
    configuredStore = createConfigIO({
      env,
      homedir,
      logger: QUIET_CONFIG_IO_LOGGER,
    }).loadConfig().session?.store;
  } catch {
    return undefined;
  }

  const trimmedStore = configuredStore?.trim();
  if (!trimmedStore || !trimmedStore.includes("{agentId}")) {
    return undefined;
  }

  if (trimmedStore.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(trimmedStore, {
        home: resolveRequiredHomeDir(env, homedir),
        env,
        homedir,
      }),
    );
  }
  return path.resolve(trimmedStore);
}

function extractAgentIdFromConfiguredSessionsTemplate(
  candidateSessionsDir: string,
  configuredSessionsDirTemplate: string,
): string | undefined {
  const comparableTemplate = resolveComparableConfiguredPathTemplate(configuredSessionsDirTemplate);
  const comparableCandidate = resolveComparableManagedPath(candidateSessionsDir);
  const compareCaseInsensitively = shouldCompareManagedPathsCaseInsensitively(
    comparableTemplate.replaceAll(AGENT_ID_TEMPLATE_SENTINEL, "openclaw-agent-id-probe"),
  );
  return extractAgentIdFromNormalizedConfiguredSessionsTemplate(
    normalizeManagedPathForComparison(comparableCandidate, compareCaseInsensitively),
    normalizeManagedPathForComparison(comparableTemplate, compareCaseInsensitively),
  );
}

function resolveComparableConfiguredPathTemplate(configuredTemplate: string): string {
  return resolveComparableManagedPath(
    configuredTemplate.replaceAll("{agentId}", AGENT_ID_TEMPLATE_SENTINEL),
  );
}

function extractAgentIdFromNormalizedConfiguredSessionsTemplate(
  normalizedCandidateSessionsDir: string,
  normalizedConfiguredSessionsDirTemplate: string,
): string | undefined {
  const templateParts = normalizedConfiguredSessionsDirTemplate.split(AGENT_ID_TEMPLATE_SENTINEL);
  if (templateParts.length < 2) {
    return undefined;
  }

  let cursor = 0;
  let extractedAgentId: string | undefined;
  for (let index = 0; index < templateParts.length; index++) {
    const part = templateParts[index];
    if (!normalizedCandidateSessionsDir.startsWith(part, cursor)) {
      return undefined;
    }
    cursor += part.length;

    if (index === templateParts.length - 1) {
      return cursor === normalizedCandidateSessionsDir.length ? extractedAgentId : undefined;
    }

    const nextPart = templateParts[index + 1];
    const nextPartIndex =
      nextPart.length === 0
        ? normalizedCandidateSessionsDir.length
        : normalizedCandidateSessionsDir.indexOf(nextPart, cursor);
    if (nextPartIndex < 0) {
      return undefined;
    }

    const currentCapture = normalizedCandidateSessionsDir.slice(cursor, nextPartIndex);
    if (!currentCapture) {
      return undefined;
    }
    if (extractedAgentId === undefined) {
      extractedAgentId = currentCapture;
    } else if (currentCapture !== extractedAgentId) {
      return undefined;
    }
    cursor = nextPartIndex;
  }

  return undefined;
}

function resolvePathWithinSessionsDir(
  sessionsDir: string,
  candidate: string,
  opts?: { agentId?: string },
): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error("Session file path must not be empty");
  }
  const resolvedBase = path.resolve(sessionsDir);
  const realBase = safeRealpathSync(resolvedBase) ?? resolvedBase;
  // Normalize absolute paths that are within the sessions directory.
  // Older versions stored absolute sessionFile paths in sessions.json;
  // convert them to relative so the containment check passes.
  const realTrimmed = path.isAbsolute(trimmed) ? (safeRealpathSync(trimmed) ?? trimmed) : trimmed;
  const normalized = path.isAbsolute(realTrimmed)
    ? path.relative(realBase, realTrimmed)
    : realTrimmed;
  if (normalized.startsWith("..") && path.isAbsolute(realTrimmed)) {
    const tryAgentFallback = (agentId: string): string | undefined => {
      const normalizedAgentId = normalizeAgentId(agentId);
      const siblingSessionsDir = resolveSiblingAgentSessionsDir(realBase, normalizedAgentId);
      if (siblingSessionsDir) {
        const siblingResolved = resolvePathFromAgentSessionsDir(siblingSessionsDir, realTrimmed);
        if (siblingResolved) {
          return siblingResolved;
        }
      }
      return resolvePathFromAgentSessionsDir(
        resolveAgentSessionsDir(normalizedAgentId),
        realTrimmed,
      );
    };

    const explicitAgentId = opts?.agentId?.trim();
    if (explicitAgentId) {
      const resolvedFromAgent = tryAgentFallback(explicitAgentId);
      if (resolvedFromAgent) {
        return resolvedFromAgent;
      }
    }
    const extractedAgentId = extractAgentIdFromAbsoluteSessionPath(realTrimmed);
    if (extractedAgentId) {
      const resolvedFromPath = tryAgentFallback(extractedAgentId);
      if (resolvedFromPath) {
        return resolvedFromPath;
      }
      // Cross-root compatibility for older absolute paths:
      // keep only canonical .../agents/<agentId>/sessions/<file> shapes.
      const structuralFallback = resolveStructuralSessionFallbackPath(
        realTrimmed,
        extractedAgentId,
      );
      if (structuralFallback) {
        return structuralFallback;
      }
    }
  }
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Session file path must be within sessions directory");
  }
  return path.resolve(realBase, normalized);
}

export function resolveSessionTranscriptPathInDir(
  sessionId: string,
  sessionsDir: string,
  topicId?: string | number,
): string {
  const safeSessionId = validateSessionId(sessionId);
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId !== undefined
      ? `${safeSessionId}-topic-${safeTopicId}.jsonl`
      : `${safeSessionId}.jsonl`;
  return resolvePathWithinSessionsDir(sessionsDir, fileName);
}

export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: string | number,
): string {
  return resolveSessionTranscriptPathInDir(sessionId, resolveAgentSessionsDir(agentId), topicId);
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  opts?: SessionFilePathOptions,
): string {
  const sessionsDir = resolveSessionsDir(opts);
  const candidate = entry?.sessionFile?.trim();
  if (candidate) {
    try {
      return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
    } catch {
      // Keep handlers alive when persisted metadata is stale/corrupt.
    }
  }
  return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}

export function resolveStorePath(
  store?: string,
  opts?: { agentId?: string; env?: NodeJS.ProcessEnv; homedir?: () => string },
) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  const env = opts?.env ?? process.env;
  const homedir = opts?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir));
  if (!store) {
    return path.join(resolveAgentSessionsDir(agentId, env, homedir), "sessions.json");
  }
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      return path.resolve(
        expandHomePrefix(expanded, {
          home: resolveRequiredHomeDir(env, homedir),
          env,
          homedir,
        }),
      );
    }
    return path.resolve(expanded);
  }
  if (store.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(store, {
        home: resolveRequiredHomeDir(env, homedir),
        env,
        homedir,
      }),
    );
  }
  return path.resolve(store);
}

export function resolveAgentsDirFromSessionStorePath(storePath: string): string | undefined {
  const candidateAbsPath = path.resolve(storePath);
  if (path.basename(candidateAbsPath) !== "sessions.json") {
    return undefined;
  }
  const sessionsDir = path.dirname(candidateAbsPath);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    return undefined;
  }
  return agentsDir;
}
