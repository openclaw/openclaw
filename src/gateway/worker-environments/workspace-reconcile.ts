import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsSafeError, root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { runCommandBuffered, runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
  type WorkerWorkspaceReconciliationJournal,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import {
  prepareNonDirectoryTargets,
  reconciliationDirectories,
  reconciliationEntries,
} from "./workspace-reconcile-derived-paths.js";
import {
  absoluteEntryMatches,
  clearTemporaryWorkspace,
  directoryContainsOnlyDerivedWorkspaceEntries,
  directoryContainsOnlyJournalPaths,
  entryMatches,
  localPath,
  readWorkspaceFileSnapshot,
  readWorkspaceTreeFile,
} from "./workspace-reconcile-fs.js";
export {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceReconciliationJournal,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";

const PATCH_TIMEOUT_MS = 10 * 60_000;
const MAX_RECONCILIATION_PATH_BYTES = 64 * 1024 * 1024;

class ConcurrentWorkspacePathError extends Error {}

type WorkspaceNode =
  | WorkerWorkspaceManifestEntry
  | { path: string; type: "directory" }
  | { path: string; type: "unsupported" }
  | undefined;

export type WorkerWorkspaceApplyResult = {
  manifestRef: string;
  manifest: WorkerWorkspaceManifest;
  conflictPaths: string[];
  verifyLocalStable(): Promise<void>;
};

export async function assertWorkspaceMatchesManifest(params: {
  root: string;
  manifest: WorkerWorkspaceManifest;
  entries?: readonly WorkerWorkspaceManifestEntry[];
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const expectedNodes = params.entries
    ? reconciliationEntries(params.entries)
    : [...manifestNodes(params.manifest).values()].filter(
        (entry): entry is Exclude<WorkspaceNode, undefined> => entry !== undefined,
      );
  for (const entry of expectedNodes) {
    const matches =
      entry.type === "file" || entry.type === "symlink"
        ? await entryMatches(root, entry)
        : sameEntry(await localWorkspaceNode(root, entry.path), entry);
    if (!matches) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed after cloud dispatch: ${entry.path}`,
      );
    }
  }
}

function sameEntry(left: WorkspaceNode, right: WorkspaceNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function manifestNodes(manifest: WorkerWorkspaceManifest): Map<string, WorkspaceNode> {
  return new Map<string, WorkspaceNode>([
    ...reconciliationDirectories(manifest.directories).map(
      (entryPath) =>
        [
          entryPath,
          {
            path: entryPath,
            type: "directory",
          } as const,
        ] as const,
    ),
    ...reconciliationEntries(manifest.entries).map((entry) => [entry.path, entry] as const),
  ]);
}

function hasPathAncestor(paths: ReadonlySet<string>, entryPath: string): boolean {
  const segments = entryPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    if (paths.has(segments.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
}

function isPortableWorkspaceSymlink(root: string, entryPath: string, target: string): boolean {
  if (
    !target ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.win32.parse(target).root !== ""
  ) {
    return false;
  }
  const resolved = path.resolve(path.dirname(localPath(root, entryPath)), target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function localWorkspaceNode(root: string, entryPath: string): Promise<WorkspaceNode> {
  const absolute = localPath(root, entryPath);
  const stats = await fs.lstat(absolute).catch((error: unknown) => {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return undefined;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    return { path: entryPath, type: "directory" };
  }
  if (stats.isSymbolicLink()) {
    return { path: entryPath, type: "symlink", mode: 0o777, target: await fs.readlink(absolute) };
  }
  if (!stats.isFile()) {
    return { path: entryPath, type: "unsupported" };
  }
  const snapshot = await readWorkspaceFileSnapshot(root, entryPath);
  if (snapshot.type === "unsupported") {
    return { path: entryPath, type: "unsupported" };
  }
  return {
    path: entryPath,
    type: "file",
    mode: snapshot.mode,
    size: snapshot.size,
    sha256: snapshot.sha256,
  };
}

async function localWorkspaceDescendantPaths(
  root: string,
  entryPaths: readonly string[],
): Promise<string[]> {
  const paths: string[] = [];
  const pending = [...entryPaths];
  let pathBytes = 0;
  let enumeratedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const names: string[] = [];
    for await (const entry of await fs.opendir(localPath(root, directory))) {
      names.push(entry.name);
      enumeratedEntries += 1;
      if (enumeratedEntries > MAX_RECONCILIATION_ENTRIES) {
        throw new Error("Gateway workspace manifest has too many entries");
      }
    }
    for (const name of names.toSorted()) {
      const childPath = `${directory}/${name}`;
      pathBytes += Buffer.byteLength(childPath);
      if (pathBytes > MAX_RECONCILIATION_PATH_BYTES) {
        throw new Error("Gateway workspace manifest paths exceed their byte limit");
      }
      if (isDerivedWorkspacePath(childPath)) {
        continue;
      }
      paths.push(childPath);
      const stats = await fs.lstat(localPath(root, childPath));
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(childPath);
      }
    }
  }
  return paths;
}

async function readActualWorkspaceManifest(params: {
  root: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
}): Promise<{ manifest: WorkerWorkspaceManifest; manifestRef: string }> {
  const rawEntries: Array<
    WorkerWorkspaceManifestEntry | { path: string; type: "directory"; mode: number }
  > = [];
  let totalBytes = 0;
  let traversedEntries = 0;
  let traversedPathBytes = 0;
  const addEntry = (entry: (typeof rawEntries)[number], bytes = 0): void => {
    totalBytes += bytes;
    if (totalBytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Gateway workspace manifest exceeds its byte limit");
    }
    rawEntries.push(entry);
    if (rawEntries.length > MAX_RECONCILIATION_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
  };
  const walk = async (
    relativeDirectory: string,
  ): Promise<{ hasDerivedEntry: boolean; included: boolean }> => {
    const absoluteDirectory = relativeDirectory
      ? localPath(params.root, relativeDirectory)
      : params.root;
    let hasDerivedEntry = false;
    let hasNonDerivedEntry = false;
    for await (const directoryEntry of await fs.opendir(absoluteDirectory)) {
      const name = directoryEntry.name;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      traversedEntries += 1;
      traversedPathBytes += Buffer.byteLength(relative);
      if (traversedEntries > MAX_RECONCILIATION_ENTRIES) {
        throw new Error("Gateway workspace manifest has too many entries");
      }
      if (traversedPathBytes > MAX_RECONCILIATION_PATH_BYTES) {
        throw new Error("Gateway workspace manifest paths exceed their byte limit");
      }
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      if (isDerivedWorkspacePath(relative)) {
        hasDerivedEntry = true;
        continue;
      }
      const absolute = localPath(params.root, relative);
      const stats = await fs.lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        const child = await walk(relative);
        if (child.included || params.preserveDirectories?.has(relative)) {
          addEntry({ path: relative, type: "directory", mode: stats.mode & 0o777 });
          hasNonDerivedEntry = true;
        } else {
          hasDerivedEntry ||= child.hasDerivedEntry;
        }
      } else if (stats.isSymbolicLink()) {
        hasNonDerivedEntry = true;
        const target = await fs.readlink(absolute);
        if (!isPortableWorkspaceSymlink(params.root, relative, target)) {
          // Like other unsupported local nodes, an escaping symlink is retained
          // as a conflict but omitted from the canonical cloud manifest.
          continue;
        }
        addEntry(
          {
            path: relative,
            type: "symlink",
            mode: 0o777,
            target,
          },
          Buffer.byteLength(target),
        );
      } else if (stats.isFile()) {
        hasNonDerivedEntry = true;
        const snapshot = await readWorkspaceFileSnapshot(params.root, relative);
        if (snapshot.type === "unsupported") {
          // Oversized local state is kept in place just like a special node. It
          // is omitted from the portable manifest and conflicts if cloud changed it.
          continue;
        }
        addEntry(
          {
            path: relative,
            type: "file",
            mode: snapshot.mode,
            size: snapshot.size,
            sha256: snapshot.sha256,
          },
          snapshot.size,
        );
      } else {
        hasNonDerivedEntry = true;
        // Special local nodes cannot be represented in a cloud manifest. They
        // remain in place and are surfaced as conflicts when the worker changed
        // the same path; omitting them lets that conflicted turn still finish.
        continue;
      }
    }
    return {
      hasDerivedEntry,
      // Preserve real empty directories, but omit a directory whose only
      // physical contents are excluded derived paths.
      included: hasNonDerivedEntry || !hasDerivedEntry,
    };
  };
  await walk("");
  const directories = rawEntries
    .filter((entry) => entry.type === "directory")
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: params.baseCommit,
    entries: rawEntries
      .filter((entry): entry is WorkerWorkspaceManifestEntry => entry.type !== "directory")
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    directories: directories.map((entry) => entry.path),
  };
  const raw = serializeWorkerWorkspaceManifest(manifest);
  const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return {
    manifestRef,
    manifest,
  };
}

export async function inspectAcceptedWorkerWorkspace(params: {
  root: string;
  expectedManifestRef: string;
  allowAdvancedLocalState?: boolean;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<WorkerWorkspaceApplyResult | undefined> {
  const root = await fs.realpath(params.root);
  const preserveDirectories = new Set(reconciliationDirectories(params.current.directories));
  const actual = await readActualWorkspaceManifest({
    root,
    baseCommit: params.current.baseCommit,
    preserveDirectories,
  });
  if (actual.manifestRef !== params.expectedManifestRef && !params.allowAdvancedLocalState) {
    return undefined;
  }
  const preflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  const conflictPaths = params.allowAdvancedLocalState
    ? retainedConflictPaths(preflight)
    : preflight.conflictPaths;
  return {
    ...actual,
    conflictPaths,
    verifyLocalStable: async () =>
      await assertActualWorkspaceManifest({
        root,
        expectedRef: actual.manifestRef,
        baseCommit: actual.manifest.baseCommit,
        preserveDirectories,
      }),
  };
}

async function assertActualWorkspaceManifest(params: {
  root: string;
  expectedRef: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
}): Promise<void> {
  const actual = await readActualWorkspaceManifest(params);
  if (actual.manifestRef !== params.expectedRef) {
    throw new ConcurrentWorkspacePathError("Gateway workspace changed after cloud reconciliation");
  }
}

function changedPaths(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
): Set<string> {
  const baseByPath = manifestNodes(base);
  const currentByPath = manifestNodes(current);
  return new Set(
    [...new Set([...baseByPath.keys(), ...currentByPath.keys()])].filter(
      (entryPath) => !sameEntry(baseByPath.get(entryPath), currentByPath.get(entryPath)),
    ),
  );
}

async function applyWorkspaceDirectoryChanges(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  applyPaths: ReadonlySet<string>;
}): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(params.root, { mode: 0o700 });
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const directoryPaths = [...params.applyPaths].filter(
    (entryPath) =>
      baseNodes.get(entryPath)?.type === "directory" ||
      currentNodes.get(entryPath)?.type === "directory",
  );
  for (const entryPath of directoryPaths.toSorted()) {
    const currentDirectory = currentNodes.get(entryPath);
    if (currentDirectory?.type === "directory") {
      await workspaceRoot.mkdir(entryPath);
    }
  }
  const removedDirectoryPaths = directoryPaths.filter(
    (entryPath) => baseNodes.get(entryPath)?.type === "directory" && !currentNodes.has(entryPath),
  );
  for (const entryPath of removedDirectoryPaths.toSorted((left, right) =>
    right.localeCompare(left),
  )) {
    const baseDirectory = baseNodes.get(entryPath);
    let directoryState;
    try {
      directoryState = await workspaceRoot.stat(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (!directoryState.isDirectory || baseDirectory?.type !== "directory") {
      // A concurrent local replacement or chmod wins and becomes a conflict.
      continue;
    }
    let children: string[];
    try {
      children = await workspaceRoot.list(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (children.length > 0) {
      // Conflicted descendants deliberately keep their containing directory
      // even when the cloud result removed that directory.
      continue;
    }
    try {
      await workspaceRoot.remove(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      const racedChildren = await workspaceRoot.list(entryPath).catch(() => undefined);
      if (racedChildren?.length) {
        continue;
      }
      throw error;
    }
  }
}

function hasReplacedBaseEntryAncestor(
  entryPath: string,
  baseByPath: ReadonlyMap<string, WorkerWorkspaceManifestEntry>,
  currentByPath: ReadonlyMap<string, WorkerWorkspaceManifestEntry>,
): boolean {
  const segments = entryPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    const baseEntry = baseByPath.get(ancestor);
    if (baseEntry && !sameEntry(baseEntry, currentByPath.get(ancestor))) {
      return true;
    }
  }
  return false;
}

async function preflightWorkspaceApply(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<{
  applyPaths: Set<string>;
  conflictPaths: string[];
  blockingConflictPaths: string[];
}> {
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const manifestPaths = [...new Set([...baseNodes.keys(), ...currentNodes.keys()])];
  const changed = new Set(
    manifestPaths.filter(
      (entryPath) => !sameEntry(baseNodes.get(entryPath), currentNodes.get(entryPath)),
    ),
  );
  const structurallyReplacedDirectories = new Set(
    [...changed].filter(
      (entryPath) =>
        baseNodes.get(entryPath)?.type === "directory" &&
        currentNodes.get(entryPath)?.type !== "directory",
    ),
  );
  const structuralRoots = [...structurallyReplacedDirectories].filter(
    (entryPath) => !hasPathAncestor(structurallyReplacedDirectories, entryPath),
  );
  const localStructuralRoots: string[] = [];
  for (const entryPath of structuralRoots) {
    const stats = await fs.lstat(localPath(params.root, entryPath)).catch(() => undefined);
    if (stats?.isDirectory() && !stats.isSymbolicLink()) {
      localStructuralRoots.push(entryPath);
    }
  }
  // Traverse disjoint replacement roots once with one shared budget. A manifest
  // lists every nested directory, so walking from each changed path is quadratic.
  const localStructuralPaths = await localWorkspaceDescendantPaths(
    params.root,
    localStructuralRoots,
  );
  const paths = [...new Set([...changed, ...localStructuralPaths])].toSorted();
  const applyPaths = new Set<string>();
  const conflicts = new Set<string>();
  const blockingConflicts = new Set<string>();
  for (const entryPath of paths) {
    if (hasPathAncestor(blockingConflicts, entryPath)) {
      continue;
    }
    const currentNode = currentNodes.get(entryPath);
    const deletionAlreadySatisfied =
      currentNode === undefined &&
      !(await fs.lstat(localPath(params.root, entryPath)).catch((error: unknown) => {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          return undefined;
        }
        throw error;
      }));
    if (deletionAlreadySatisfied) {
      // A deletion can already be satisfied because local also removed an
      // unchanged ancestor. Do not turn that convergence into a conflict.
      continue;
    }
    const segments = entryPath.split("/");
    let localAncestorConflict = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const baseAncestor = baseNodes.get(ancestor);
      const currentAncestor = currentNodes.get(ancestor);
      if (!baseAncestor && !currentAncestor) {
        const localAncestor = await localWorkspaceNode(params.root, ancestor);
        if (localAncestor && localAncestor.type !== "directory") {
          conflicts.add(ancestor);
          blockingConflicts.add(ancestor);
          localAncestorConflict = true;
          break;
        }
        continue;
      }
      const localAncestor = await localWorkspaceNode(params.root, ancestor);
      const localStructurallyMatchesBase =
        localAncestor?.type === "directory" && baseAncestor?.type === "directory"
          ? true
          : sameEntry(localAncestor, baseAncestor);
      const localStructurallyMatchesCurrent =
        localAncestor?.type === "directory" && currentAncestor?.type === "directory"
          ? true
          : sameEntry(localAncestor, currentAncestor);
      if (!localStructurallyMatchesBase && !localStructurallyMatchesCurrent) {
        conflicts.add(ancestor);
        blockingConflicts.add(ancestor);
        localAncestorConflict = true;
        break;
      }
    }
    if (localAncestorConflict) {
      continue;
    }
    let local: WorkspaceNode;
    let replacedBaseAncestor = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const baseAncestor = baseNodes.get(ancestor);
      if (
        baseAncestor &&
        baseAncestor.type !== "directory" &&
        !sameEntry(baseAncestor, currentNodes.get(ancestor)) &&
        sameEntry(await localWorkspaceNode(params.root, ancestor), baseAncestor)
      ) {
        replacedBaseAncestor = true;
        break;
      }
    }
    if (replacedBaseAncestor) {
      local = undefined;
    } else {
      local = await localWorkspaceNode(params.root, entryPath);
      if (
        local?.type === "directory" &&
        (!baseNodes.has(entryPath) || !currentNodes.has(entryPath)) &&
        currentNodes.get(entryPath)?.type !== "directory" &&
        (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, entryPath))
      ) {
        local = undefined;
      }
    }
    if (sameEntry(local, baseNodes.get(entryPath))) {
      if (changed.has(entryPath)) {
        applyPaths.add(entryPath);
      }
    } else if (!sameEntry(local, currentNodes.get(entryPath))) {
      conflicts.add(entryPath);
      const current = currentNodes.get(entryPath);
      if (
        (current?.type === "directory" && local !== undefined && local.type !== "directory") ||
        (current !== undefined && current.type !== "directory" && local?.type === "directory")
      ) {
        blockingConflicts.add(entryPath);
      }
    }
  }
  // Replacing a directory with a file/symlink would erase every descendant in
  // one filesystem operation. Lift a descendant conflict to that replacement.
  const initialConflictPaths = Array.from(conflicts);
  for (const conflictPath of initialConflictPaths) {
    const segments = conflictPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const workerNode = currentNodes.get(ancestor);
      if (changed.has(ancestor) && workerNode && workerNode.type !== "directory") {
        conflicts.add(ancestor);
        blockingConflicts.add(ancestor);
        break;
      }
    }
  }
  const conflictPaths = [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
  const blockingConflictPaths = [...blockingConflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
  const conflictPathSet = new Set(conflictPaths);
  const blockingConflictPathSet = new Set(blockingConflictPaths);
  for (const entryPath of applyPaths) {
    if (conflictPathSet.has(entryPath) || hasPathAncestor(blockingConflictPathSet, entryPath)) {
      applyPaths.delete(entryPath);
    }
  }
  return { applyPaths, conflictPaths, blockingConflictPaths };
}

function retainedConflictPaths(
  preflight: {
    applyPaths: ReadonlySet<string>;
    conflictPaths: readonly string[];
    blockingConflictPaths: readonly string[];
  },
  originalApplyPaths?: ReadonlySet<string>,
): string[] {
  const retainedApplyPaths = [...preflight.applyPaths].filter(
    (entryPath) =>
      !originalApplyPaths?.has(entryPath) ||
      !preflight.conflictPaths.some((conflictPath) => conflictPath.startsWith(`${entryPath}/`)),
  );
  const conflicts = new Set([...preflight.conflictPaths, ...retainedApplyPaths]);
  const blockingConflicts = new Set(preflight.blockingConflictPaths);
  return [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
}

export async function assertWorkspaceResultStable(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<void> {
  await assertWorkspaceMatchesManifest({ root: params.root, manifest: params.current });
  const preflight = await preflightWorkspaceApply(params);
  const unstablePath = preflight.conflictPaths[0] ?? preflight.applyPaths.values().next().value;
  if (unstablePath) {
    throw new ConcurrentWorkspacePathError(
      `Gateway workspace changed after cloud dispatch: ${unstablePath}`,
    );
  }
}

async function requireGit(
  cwd: string,
  args: string[],
  input?: Uint8Array,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs: PATCH_TIMEOUT_MS,
    ...(input ? { input } : {}),
    ...(env ? { env } : {}),
    maxOutputBytes: 1024 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

async function materializeSnapshotEntry(params: {
  root: string;
  entry: WorkerWorkspaceManifestEntry;
  sourceRoot?: string;
  content?: Uint8Array;
}): Promise<void> {
  const target = localPath(params.root, params.entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (params.entry.type === "symlink") {
    await fs.symlink(params.entry.target, target);
    return;
  }
  if (params.content) {
    await fs.writeFile(target, params.content, { mode: params.entry.mode, flag: "wx" });
  } else if (params.sourceRoot) {
    await fs.copyFile(localPath(params.sourceRoot, params.entry.path), target);
  } else {
    throw new Error(`Cloud workspace snapshot content is missing: ${params.entry.path}`);
  }
  await fs.chmod(target, params.entry.mode);
  if (!(await absoluteEntryMatches(target, params.entry))) {
    throw new Error(`Cloud workspace staged payload is invalid: ${params.entry.path}`);
  }
}

async function writeRawWorkspaceTree(params: {
  repositoryRoot: string;
  entries: readonly WorkerWorkspaceManifestEntry[];
}): Promise<string> {
  // fast-import writes the authenticated bytes directly. A working-tree/index
  // snapshot would apply user attributes, encodings, and clean filters.
  const blobs: Array<{ entry: WorkerWorkspaceManifestEntry; mark: number; content: Uint8Array }> =
    [];
  let mark = 1;
  for (const entry of reconciliationEntries(params.entries).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const content =
      entry.type === "symlink"
        ? Buffer.from(entry.target)
        : await fs.readFile(localPath(params.repositoryRoot, entry.path));
    blobs.push({ entry, mark, content });
    mark += 1;
  }
  const ref = `refs/heads/openclaw-snapshot-${randomBytes(16).toString("hex")}`;
  const chunks: Uint8Array[] = [];
  for (const blob of blobs) {
    chunks.push(Buffer.from(`blob\nmark :${blob.mark}\ndata ${blob.content.byteLength}\n`));
    chunks.push(blob.content, Buffer.from("\n"));
  }
  chunks.push(
    Buffer.from(
      `commit ${ref}\ncommitter OpenClaw <noreply@openclaw.ai> 0 +0000\ndata 0\ndeleteall\n`,
    ),
  );
  for (const blob of blobs) {
    const mode =
      blob.entry.type === "symlink"
        ? "120000"
        : (blob.entry.mode & 0o111) !== 0
          ? "100755"
          : "100644";
    chunks.push(Buffer.from(`M ${mode} :${blob.mark} ${JSON.stringify(blob.entry.path)}\n`));
  }
  chunks.push(Buffer.from("done\n"));
  const imported = await runCommandBuffered(
    ["git", "-C", params.repositoryRoot, "fast-import", "--quiet"],
    {
      input: Buffer.concat(chunks),
      timeoutMs: PATCH_TIMEOUT_MS,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 1024 * 1024 },
    },
  );
  if (imported.termination !== "exit" || imported.code !== 0) {
    throw new Error(imported.stderr.toString("utf8").trim() || "git fast-import failed");
  }
  return await requireGit(params.repositoryRoot, ["rev-parse", `${ref}^{tree}`]);
}

async function createWorkspacePatch(params: {
  root: string;
  stagingRoot: string;
  baseEntries: WorkerWorkspaceManifestEntry[];
  appliedEntries: WorkerWorkspaceManifestEntry[];
}): Promise<{ patch: Uint8Array; baseTree: string; basePack: Uint8Array }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-patch-"));
  try {
    // Rollback journals have a fixed SHA-1 object-id contract. Do not inherit
    // user or process defaults that can switch temporary repositories to SHA-256.
    await requireGit(temporary, ["init", "--quiet", "--object-format=sha1"]);
    let bytes = 0;
    for (const entry of params.baseEntries) {
      let content: Uint8Array | undefined;
      if (entry.type === "file") {
        if (entry.size > MAX_RECONCILIATION_FILE_BYTES) {
          throw new Error(`Cloud workspace rollback file is too large: ${entry.path}`);
        }
        content = await fs.readFile(localPath(params.root, entry.path));
        bytes += content.byteLength;
      }
      if (bytes > MAX_RECONCILIATION_TOTAL_BYTES) {
        throw new Error("Cloud workspace rollback exceeds its byte limit");
      }
      await materializeSnapshotEntry({ root: temporary, entry, content });
    }
    const baseTree = await writeRawWorkspaceTree({
      repositoryRoot: temporary,
      entries: params.baseEntries,
    });
    const packed = await runCommandBuffered(
      ["git", "-C", temporary, "pack-objects", "--stdout", "--revs"],
      {
        input: Buffer.from(`${baseTree}\n`),
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: {
          stdout: MAX_RECONCILIATION_TOTAL_BYTES + 1,
          stderr: 1024 * 1024,
        },
      },
    );
    if (packed.termination !== "exit" || packed.code !== 0) {
      throw new Error(packed.stderr.toString("utf8").trim() || "git pack-objects failed");
    }
    if (packed.stdout.byteLength > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace recovery snapshot exceeds its byte limit");
    }
    for (const name of await fs.readdir(temporary)) {
      if (name !== ".git") {
        await fs.rm(path.join(temporary, name), { recursive: true, force: true });
      }
    }
    for (const entry of params.appliedEntries) {
      await materializeSnapshotEntry({
        root: temporary,
        entry,
        sourceRoot: params.stagingRoot,
      });
    }
    const appliedTree = await writeRawWorkspaceTree({
      repositoryRoot: temporary,
      entries: params.appliedEntries,
    });
    const diff = await runCommandBuffered(
      [
        "git",
        "-C",
        temporary,
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        baseTree,
        appliedTree,
        "--",
      ],
      {
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: {
          stdout: MAX_RECONCILIATION_TOTAL_BYTES + 1,
          stderr: 1024 * 1024,
        },
      },
    );
    if (diff.termination !== "exit" || diff.code !== 0) {
      throw new Error(diff.stderr.toString("utf8").trim() || "git diff failed");
    }
    if (diff.stdout.byteLength > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace patch exceeds its byte limit");
    }
    return { patch: diff.stdout, baseTree, basePack: packed.stdout };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function applyWorkspacePatch(params: {
  root: string;
  patch: Uint8Array;
  reverse?: boolean;
}): Promise<void> {
  if (params.patch.byteLength === 0) {
    return;
  }
  // Run no-index with discovery disabled so workspace .gitattributes and
  // repository filter config cannot reinterpret authenticated patch bytes.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-git-"));
  try {
    await requireGit(
      params.root,
      [
        "apply",
        "--no-index",
        "--binary",
        "--whitespace=nowarn",
        ...(params.reverse ? ["--reverse"] : []),
      ],
      params.patch,
      { GIT_DIR: path.join(temporary, ".git") },
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function validateJournalSnapshot(journal: WorkerWorkspaceReconciliationJournal): void {
  if (
    journal.basePack.byteLength > MAX_RECONCILIATION_TOTAL_BYTES ||
    !/^[a-f0-9]{40}$/u.test(journal.baseTree) ||
    createHash("sha256").update(journal.basePack).digest("hex") !== journal.basePackSha256
  ) {
    throw new Error("Cloud workspace reconciliation recovery snapshot is invalid");
  }
}

async function createWorkspaceRecoveryPatch(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
}): Promise<Uint8Array> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-recovery-"));
  try {
    await requireGit(temporary, ["init", "--quiet", "--object-format=sha1"]);
    await requireGit(temporary, ["index-pack", "--stdin"], params.journal.basePack);
    await requireGit(temporary, ["cat-file", "-e", `${params.journal.baseTree}^{tree}`]);
    const baseEntries = reconciliationEntries(params.journal.baseEntries);
    const appliedEntries = reconciliationEntries(params.journal.appliedEntries);
    const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
    const appliedByPath = new Map(appliedEntries.map((entry) => [entry.path, entry]));
    const paths = new Set([...baseByPath.keys(), ...appliedByPath.keys()]);
    const directories = new Set<string>();
    for (const entryPath of paths) {
      const segments = entryPath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
    }
    const actualEntries: WorkerWorkspaceManifestEntry[] = [];
    for (const entryPath of [...paths].toSorted()) {
      const absolute = localPath(params.root, entryPath);
      const stats = await fs.lstat(absolute).catch(() => undefined);
      if (!stats) {
        const baseEntry = baseByPath.get(entryPath);
        const appliedEntry = appliedByPath.get(entryPath);
        if (baseEntry && appliedEntry) {
          // A missing replacement path is ambiguous: Git may have removed the
          // old entry mid-apply, or the user may have deleted it afterward.
          throw new ConcurrentWorkspacePathError(
            `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
          );
        }
        continue;
      }
      const baseEntry = baseByPath.get(entryPath);
      const appliedEntry = appliedByPath.get(entryPath);
      if (baseEntry && (await entryMatches(params.root, baseEntry))) {
        actualEntries.push(baseEntry);
        continue;
      }
      if (appliedEntry && (await entryMatches(params.root, appliedEntry))) {
        actualEntries.push(appliedEntry);
        continue;
      }
      const isJournalDirectory =
        stats.isDirectory() &&
        !stats.isSymbolicLink() &&
        ((directories.has(entryPath) &&
          (await directoryContainsOnlyJournalPaths(params.root, entryPath, paths, directories))) ||
          (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, entryPath)));
      if (!isJournalDirectory) {
        throw new ConcurrentWorkspacePathError(
          `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
        );
      }
    }
    for (const entry of actualEntries) {
      await materializeSnapshotEntry({
        root: temporary,
        entry,
        sourceRoot: params.root,
      });
    }
    const actualTree = await writeRawWorkspaceTree({
      repositoryRoot: temporary,
      entries: actualEntries,
    });
    let recoveryBaseTree = params.journal.baseTree;
    if (baseEntries.length !== params.journal.baseEntries.length) {
      await clearTemporaryWorkspace(temporary);
      for (const entry of baseEntries) {
        const content =
          entry.type === "file"
            ? await readWorkspaceTreeFile({
                repositoryRoot: temporary,
                tree: params.journal.baseTree,
                entry,
              })
            : undefined;
        await materializeSnapshotEntry({ root: temporary, entry, content });
      }
      recoveryBaseTree = await writeRawWorkspaceTree({
        repositoryRoot: temporary,
        entries: baseEntries,
      });
      await clearTemporaryWorkspace(temporary);
    }
    const diff = await runCommandBuffered(
      [
        "git",
        "-C",
        temporary,
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        actualTree,
        recoveryBaseTree,
        "--",
      ],
      {
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: {
          stdout: MAX_RECONCILIATION_TOTAL_BYTES + 1,
          stderr: 1024 * 1024,
        },
      },
    );
    if (diff.termination !== "exit" || diff.code !== 0) {
      throw new Error(diff.stderr.toString("utf8").trim() || "git recovery diff failed");
    }
    if (diff.stdout.byteLength > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace recovery patch exceeds its byte limit");
    }
    return diff.stdout;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function assertWorkspaceRecoveryBase(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
}): Promise<void> {
  await assertWorkspaceMatchesManifest({
    root: params.root,
    manifest: { version: 1, baseCommit: null, entries: params.journal.baseEntries },
  });
  const baseEntries = reconciliationEntries(params.journal.baseEntries);
  const appliedEntries = reconciliationEntries(params.journal.appliedEntries);
  const baseDirectoryPaths = new Set(
    reconciliationDirectories(params.journal.baseDirectories ?? []),
  );
  const appliedDirectoryPaths = new Set(
    reconciliationDirectories(params.journal.appliedDirectories ?? []),
  );
  for (const entryPath of baseDirectoryPaths) {
    const node = await localWorkspaceNode(params.root, entryPath);
    if (node?.type !== "directory") {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
      );
    }
  }
  const basePaths = new Set(baseEntries.map((entry) => entry.path));
  const baseDirectories = new Set<string>();
  for (const entryPath of basePaths) {
    const segments = entryPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      baseDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const entry of appliedEntries) {
    if (basePaths.has(entry.path)) {
      continue;
    }
    const existing = await fs.lstat(localPath(params.root, entry.path)).catch(() => undefined);
    if (
      existing?.isDirectory() &&
      !existing.isSymbolicLink() &&
      baseDirectories.has(entry.path) &&
      (await directoryContainsOnlyJournalPaths(params.root, entry.path, basePaths, baseDirectories))
    ) {
      continue;
    }
    if (existing) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed while cloud recovery was pending: ${entry.path}`,
      );
    }
  }
  for (const entryPath of appliedDirectoryPaths) {
    if (baseDirectoryPaths.has(entryPath) || basePaths.has(entryPath)) {
      continue;
    }
    const node = await localWorkspaceNode(params.root, entryPath);
    if (
      node &&
      !(
        node.type === "directory" &&
        (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, entryPath))
      )
    ) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
      );
    }
  }
}

async function assertWorkspaceRecoveryDirectoriesRecoverable(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
}): Promise<void> {
  const baseDirectories = new Set(reconciliationDirectories(params.journal.baseDirectories));
  const appliedDirectories = new Set(reconciliationDirectories(params.journal.appliedDirectories));
  const baseEntries = new Map(
    reconciliationEntries(params.journal.baseEntries).map((entry) => [entry.path, entry]),
  );
  const appliedEntries = new Map(
    reconciliationEntries(params.journal.appliedEntries).map((entry) => [entry.path, entry]),
  );
  const appliedEntryPaths = new Set(appliedEntries.keys());
  const directoryPaths = new Set([...baseDirectories, ...appliedDirectories]);
  for (const entryPath of directoryPaths) {
    const local = await localWorkspaceNode(params.root, entryPath);
    if (local?.type === "directory") {
      if (
        baseEntries.has(entryPath) &&
        appliedDirectories.has(entryPath) &&
        !(await directoryContainsOnlyJournalPaths(
          params.root,
          entryPath,
          appliedEntryPaths,
          appliedDirectories,
        ))
      ) {
        throw new ConcurrentWorkspacePathError(
          `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
        );
      }
      continue;
    }
    if (!local) {
      if (baseDirectories.has(entryPath) && appliedDirectories.has(entryPath)) {
        throw new ConcurrentWorkspacePathError(
          `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
        );
      }
      continue;
    }
    const baseEntry = baseEntries.get(entryPath);
    const appliedEntry = appliedEntries.get(entryPath);
    if (
      (baseEntry && (await entryMatches(params.root, baseEntry))) ||
      (appliedEntry && (await entryMatches(params.root, appliedEntry)))
    ) {
      continue;
    }
    throw new ConcurrentWorkspacePathError(
      `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
    );
  }
}

async function restoreWorkspaceJournalDirectories(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
}): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(params.root, { mode: 0o700 });
  const baseDirectories = reconciliationDirectories(params.journal.baseDirectories ?? []);
  const appliedDirectories = new Set(
    reconciliationDirectories(params.journal.appliedDirectories ?? []),
  );
  for (const entryPath of baseDirectories.toSorted()) {
    await workspaceRoot.mkdir(entryPath);
  }
  const baseDirectoryPaths = new Set(baseDirectories);
  const baseEntryPaths = new Set(
    reconciliationEntries(params.journal.baseEntries).map((entry) => entry.path),
  );
  for (const entryPath of [...appliedDirectories].toSorted((left, right) =>
    right.localeCompare(left),
  )) {
    if (baseDirectoryPaths.has(entryPath) || baseEntryPaths.has(entryPath)) {
      continue;
    }
    let children: string[];
    try {
      children = await workspaceRoot.list(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (children.length > 0) {
      continue;
    }
    try {
      await workspaceRoot.remove(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      const racedChildren = await workspaceRoot.list(entryPath).catch(() => undefined);
      if (racedChildren?.length) {
        continue;
      }
      throw error;
    }
  }
}

export async function recoverWorkerWorkspaceReconciliation(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
  preservePaths?: ReadonlySet<string>;
}): Promise<void> {
  if (params.journal.appliedManifestRef) {
    throw new Error("Cloud workspace result is already applied and awaits fence acceptance");
  }
  if (params.preservePaths?.size) {
    throw new Error("Cloud workspace patch recovery cannot preserve partial paths");
  }
  const root = await fs.realpath(params.root);
  validateJournalSnapshot(params.journal);
  try {
    await assertWorkspaceRecoveryBase({ root, journal: params.journal });
    return;
  } catch {
    // The journal may be persisted before, during, or after the multi-file apply.
  }
  await assertWorkspaceRecoveryDirectoriesRecoverable({ root, journal: params.journal });
  const recoveryPatch = await createWorkspaceRecoveryPatch({ root, journal: params.journal });
  await prepareNonDirectoryTargets(root, params.journal.baseEntries);
  await applyWorkspacePatch({ root, patch: recoveryPatch });
  await restoreWorkspaceJournalDirectories({ root, journal: params.journal });
  await assertWorkspaceRecoveryBase({ root, journal: params.journal });
}

export async function applyStagedWorkerWorkspace(params: {
  root: string;
  stagingRoot: string;
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
}): Promise<WorkerWorkspaceApplyResult> {
  const root = await fs.realpath(params.root);
  const preserveDirectories = new Set(reconciliationDirectories(params.current.directories));
  const preflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  const changed = changedPaths(params.base, params.current);
  if (changed.size === 0) {
    const actual = await readActualWorkspaceManifest({
      root,
      baseCommit: params.current.baseCommit,
      preserveDirectories,
    });
    const finalPreflight = await preflightWorkspaceApply({
      root,
      base: params.base,
      current: params.current,
    });
    await assertActualWorkspaceManifest({
      root,
      expectedRef: actual.manifestRef,
      baseCommit: actual.manifest.baseCommit,
      preserveDirectories,
    });
    params.journal.commit(actual.manifestRef);
    return {
      ...actual,
      conflictPaths: retainedConflictPaths(finalPreflight, preflight.applyPaths),
      verifyLocalStable: async () =>
        await assertActualWorkspaceManifest({
          root,
          expectedRef: actual.manifestRef,
          baseCommit: actual.manifest.baseCommit,
          preserveDirectories,
        }),
    };
  }
  const baseByPath = new Map(
    reconciliationEntries(params.base.entries).map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    reconciliationEntries(params.current.entries).map((entry) => [entry.path, entry]),
  );
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const baseEntries = reconciliationEntries(params.base.entries).filter(
    (entry) => changed.has(entry.path) && preflight.applyPaths.has(entry.path),
  );
  const appliedEntries: WorkerWorkspaceManifestEntry[] = [];
  for (const entry of reconciliationEntries(params.current.entries)) {
    if (!changed.has(entry.path) || !preflight.applyPaths.has(entry.path)) {
      continue;
    }
    if (
      !baseByPath.has(entry.path) &&
      !hasReplacedBaseEntryAncestor(entry.path, baseByPath, currentByPath) &&
      (await entryMatches(root, entry))
    ) {
      continue;
    }
    appliedEntries.push(entry);
  }
  const baseDirectories = [...preflight.applyPaths]
    .filter((entryPath) => baseNodes.get(entryPath)?.type === "directory")
    .toSorted();
  const appliedDirectories = [...preflight.applyPaths]
    .filter((entryPath) => currentNodes.get(entryPath)?.type === "directory")
    .toSorted();
  if (
    baseEntries.length +
      appliedEntries.length +
      baseDirectories.length +
      appliedDirectories.length >
    MAX_RECONCILIATION_ENTRIES
  ) {
    throw new Error(
      `Cloud workspace reconciliation exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`,
    );
  }
  const snapshot = await createWorkspacePatch({
    root,
    stagingRoot: params.stagingRoot,
    baseEntries,
    appliedEntries,
  });
  const confirmedPreflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  if (
    JSON.stringify([...confirmedPreflight.applyPaths].toSorted()) !==
      JSON.stringify([...preflight.applyPaths].toSorted()) ||
    JSON.stringify(confirmedPreflight.conflictPaths) !== JSON.stringify(preflight.conflictPaths) ||
    JSON.stringify(confirmedPreflight.blockingConflictPaths) !==
      JSON.stringify(preflight.blockingConflictPaths)
  ) {
    throw new ConcurrentWorkspacePathError(
      "Gateway workspace changed while cloud reconciliation was being prepared",
    );
  }
  const journal: WorkerWorkspaceReconciliationJournal = {
    version: 1,
    temporaryNonce: randomBytes(16).toString("hex"),
    baseManifestRef: params.baseManifestRef,
    currentManifestRef: params.currentManifestRef,
    baseEntries,
    appliedEntries,
    baseDirectories,
    appliedDirectories,
    baseTree: snapshot.baseTree,
    basePackSha256: createHash("sha256").update(snapshot.basePack).digest("hex"),
    basePack: snapshot.basePack,
  };
  params.journal.begin(journal);
  try {
    await prepareNonDirectoryTargets(root, appliedEntries);
    await applyWorkspacePatch({ root, patch: snapshot.patch });
    await applyWorkspaceDirectoryChanges({
      root,
      base: params.base,
      current: params.current,
      applyPaths: preflight.applyPaths,
    });
    const actual = await readActualWorkspaceManifest({
      root,
      baseCommit: params.current.baseCommit,
      preserveDirectories,
    });
    const finalPreflight = await preflightWorkspaceApply({
      root,
      base: params.base,
      current: params.current,
    });
    await assertActualWorkspaceManifest({
      root,
      expectedRef: actual.manifestRef,
      baseCommit: actual.manifest.baseCommit,
      preserveDirectories,
    });
    params.journal.commit(actual.manifestRef);
    return {
      ...actual,
      conflictPaths: retainedConflictPaths(finalPreflight, preflight.applyPaths),
      verifyLocalStable: async () =>
        await assertActualWorkspaceManifest({
          root,
          expectedRef: actual.manifestRef,
          baseCommit: actual.manifest.baseCommit,
          preserveDirectories,
        }),
    };
  } catch (error) {
    try {
      await recoverWorkerWorkspaceReconciliation({ root, journal });
      params.journal.abort();
    } catch (rollbackError) {
      const recoveryError = new Error("Cloud reconciliation failed and rollback needs recovery", {
        cause: error,
      });
      Object.defineProperty(recoveryError, "rollbackError", { value: rollbackError });
      throw recoveryError;
    }
    throw error;
  }
}
