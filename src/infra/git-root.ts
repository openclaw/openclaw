import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { readFileDescriptorBoundedSync, readFileWindowFullySync } from "@openclaw/fs-safe/advanced";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { isMissingPathError } from "./errors.js";
import { unquoteGitPath } from "./git-path-quote.js";

function walkUpFrom<T>(
  startDir: string,
  opts: { maxDepth?: number },
  resolveAtDir: (dir: string) => T | null | undefined,
): T | null {
  let current = path.resolve(startDir);
  for (let i = 0; opts.maxDepth === undefined || i < opts.maxDepth; i += 1) {
    const resolved = resolveAtDir(current);
    if (resolved !== null && resolved !== undefined) {
      return resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function hasGitMarker(repoRoot: string): boolean {
  const stat = safeStatSync(path.join(repoRoot, ".git"));
  return stat ? stat.isDirectory() || stat.isFile() : false;
}

export function findGitRoot(startDir: string, opts: { maxDepth?: number } = {}): string | null {
  // A `.git` file counts as a repo marker even if it is not a valid gitdir pointer.
  return walkUpFrom(startDir, opts, (repoRoot) => (hasGitMarker(repoRoot) ? repoRoot : null));
}

function readGitMetadataFile(filePath: string): Buffer {
  const limit = 1024 * 1024;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) {
      throw new Error("Git metadata is not a bounded regular file");
    }
    const bytes = readFileDescriptorBoundedSync(fd, limit);
    if (bytes.length !== stat.size) {
      throw new Error("Git metadata changed during its read");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function readGitDirectoryPointerTarget(filePath: string, prefix = ""): string {
  const bytes = readGitMetadataFile(filePath);
  // Git's setup.c strips CR/LF, not path whitespace, and caps gitfiles at 1 MiB.
  const raw = bytes.toString("utf8").replace(/[\r\n]+$/u, "");
  if (
    !isUtf8(bytes) ||
    !raw.startsWith(prefix) ||
    raw.length === prefix.length ||
    raw.includes("\0")
  ) {
    throw new Error("Git directory pointer is incomplete or malformed");
  }
  const target = raw.slice(prefix.length);
  return path.isAbsolute(target) ? target : `${path.dirname(filePath)}${path.sep}${target}`;
}

function readGitDirectoryPointer(filePath: string, prefix = ""): string {
  return fs.realpathSync.native(readGitDirectoryPointerTarget(filePath, prefix));
}

/** A lookup needs its aliases too: unlinking a traversed symlink can strand an outside target. */
function resolveGitStoragePath(
  target: string,
  paths: Set<string>,
  assertBudget: () => void,
): string | undefined {
  assertBudget();
  const raw = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`;
  paths.add(raw);
  let canonical: string | undefined;
  try {
    canonical = fs.realpathSync.native(raw);
    paths.add(canonical);
  } catch {
    // Preserve reachable lookup entries even when a later component is unavailable.
  }
  if (raw === canonical) {
    return canonical;
  }
  const components = (value: string) =>
    value
      .slice(path.parse(value).root.length)
      .split(process.platform === "win32" ? /[\\/]/u : /\//u);
  const pending = components(raw).toReversed();
  let current = path.parse(raw).root;
  let symlinks = 0;
  while (pending.length > 0) {
    assertBudget();
    const component = pending.pop()!;
    if (!component || component === ".") {
      continue;
    }
    if (component === "..") {
      current = path.dirname(current);
      continue;
    }
    const lookup = path.join(current, component);
    paths.add(lookup);
    try {
      if (fs.lstatSync(lookup).isSymbolicLink()) {
        if (++symlinks > 40) {
          return undefined;
        }
        const link = fs.readlinkSync(lookup);
        if (path.isAbsolute(link)) {
          current = path.parse(link).root;
        }
        pending.push(...components(link).toReversed());
      } else {
        current = fs.realpathSync.native(lookup);
      }
    } catch {
      return undefined;
    }
  }
  return current === canonical ? canonical : undefined;
}

function resolveGitDirFromMarker(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
    return readGitDirectoryPointer(gitPath, "gitdir: ");
  } catch {
    return null;
  }
}

/** Resolve storage at an exact root; fleet callers run this uncached census in a worker. */
export function readGitMetadataDirectories(
  repoRoot: string,
  assertBudget: () => void = () => {},
): { gitDir: string; commonDir: string; paths: string[] } | undefined {
  const paths = new Set<string>();
  const root = resolveGitStoragePath(repoRoot, paths, assertBudget);
  if (!root) {
    return undefined;
  }
  const marker = path.join(root, ".git");
  let markerStat: fs.Stats | undefined;
  let commonMarkerExists: boolean;
  let directory: string;
  try {
    markerStat = fs.lstatSync(marker, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  if (markerStat) {
    const physicalMarker = resolveGitStoragePath(marker, paths, assertBudget);
    if (!physicalMarker) {
      return undefined;
    }
    try {
      directory = fs.statSync(physicalMarker).isDirectory()
        ? physicalMarker
        : readGitDirectoryPointerTarget(marker, "gitdir: ");
    } catch {
      return undefined;
    }
  } else {
    // A linked checkout of a bare repository records the bare root as its source.
    if (
      !safeStatSync(path.join(root, "HEAD"))?.isFile() ||
      !safeStatSync(path.join(root, "objects"))?.isDirectory() ||
      !safeStatSync(path.join(root, "refs"))?.isDirectory()
    ) {
      return undefined;
    }
    directory = root;
  }
  const gitDir = resolveGitStoragePath(directory, paths, assertBudget);
  if (!gitDir || !safeStatSync(gitDir)?.isDirectory()) {
    return undefined;
  }
  const commonMarker = path.join(gitDir, "commondir");
  try {
    commonMarkerExists = fs.lstatSync(commonMarker, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return undefined;
  }
  let commonDir = gitDir;
  if (commonMarkerExists) {
    if (!resolveGitStoragePath(commonMarker, paths, assertBudget)) {
      return undefined;
    }
    let target: string;
    try {
      target = readGitDirectoryPointerTarget(commonMarker);
    } catch {
      return undefined;
    }
    const resolved = resolveGitStoragePath(target, paths, assertBudget);
    if (!resolved || !safeStatSync(resolved)?.isDirectory()) {
      return undefined;
    }
    commonDir = resolved;
  }
  return { gitDir, commonDir, paths: [...paths] };
}

export type GitObjectStorageDependencies = { paths: string[]; complete: boolean };

export type GitWorktreeAdministration = {
  checkoutPath: string;
  adminPath: string;
  physicalAdminPath: string;
};

function resolveRelativeWorktreePath(base: string, relative: string, assertBudget: () => void) {
  let resolved = base;
  const components = relative.split(process.platform === "win32" ? /[\\/]/u : /\//u);
  for (const component of components) {
    assertBudget();
    if (!component || component === ".") {
      continue;
    }
    if (component === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, component);
    try {
      resolved = fs.realpathSync.native(next);
    } catch (error) {
      // Native relative backlinks permit missing checkout suffixes, not unreadable aliases.
      try {
        if (!isMissingPathError(error) || fs.lstatSync(next, { throwIfNoEntry: false })) {
          return undefined;
        }
      } catch {
        return undefined;
      }
      resolved = next;
    }
  }
  return resolved;
}

/** Native removal owns common/worktrees/<id>, independently of the checkout's .git marker. */
export function readGitWorktreeAdministrations(
  commonDir: string,
  assertBudget: () => void,
): { entries: GitWorktreeAdministration[]; complete: boolean } {
  const entries: GitWorktreeAdministration[] = [];
  const root = path.join(commonDir, "worktrees");
  let complete = true;
  let directory: fs.Dir;
  assertBudget();
  try {
    directory = fs.opendirSync(root);
  } catch (error) {
    return {
      entries,
      complete: isMissingPathError(error) && !fs.lstatSync(root, { throwIfNoEntry: false }),
    };
  }
  try {
    for (;;) {
      assertBudget();
      let entry: fs.Dirent | null;
      try {
        entry = directory.readSync();
      } catch {
        complete = false;
        break;
      }
      if (!entry) {
        break;
      }
      const adminPath = path.join(root, entry.name);
      let backlink: string;
      let physicalAdminPath: string;
      try {
        const marker = path.join(adminPath, "gitdir");
        if (!fs.lstatSync(marker, { throwIfNoEntry: false })) {
          continue;
        }
        const bytes = readGitMetadataFile(marker);
        // worktree.c rtrims ASCII whitespace, then strips the literal /.git suffix.
        backlink = bytes
          .toString("utf8")
          .replace(/[\t-\r ]+$/u, "")
          .replace(/\/\.git$/u, "");
        if (!backlink || !isUtf8(bytes) || backlink.includes("\0")) {
          complete = false;
          continue;
        }
        physicalAdminPath = fs.realpathSync.native(adminPath);
      } catch {
        complete = false;
        continue;
      }
      // Budget failures must leave the entire census; filesystem failures retain partial facts.
      const checkoutPath = path.isAbsolute(backlink)
        ? backlink
        : resolveRelativeWorktreePath(physicalAdminPath, backlink, assertBudget);
      if (!checkoutPath) {
        complete = false;
        continue;
      }
      entries.push({ checkoutPath, adminPath, physicalAdminPath });
    }
  } finally {
    directory.closeSync();
  }
  assertBudget();
  return { entries, complete };
}

/** Git's object graph follows only info/alternates; each deletion census reads it anew. */
export function readGitObjectStorageDependencies(
  commonDir: string,
  assertBudget: () => void,
): GitObjectStorageDependencies {
  const paths = new Set<string>();
  const visited = new Set<string>();
  let complete = true;
  const visit = (target: string, depth: number) => {
    assertBudget();
    const directory = resolveGitStoragePath(target, paths, assertBudget);
    if (!directory) {
      complete = false;
      return;
    }
    let bytes: Buffer;
    const marker = path.join(directory, "info", "alternates");
    try {
      if (!fs.statSync(directory).isDirectory()) {
        complete = false;
        return;
      }
      const key = process.platform === "win32" ? directory.toLowerCase() : directory;
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      if (!fs.lstatSync(marker, { throwIfNoEntry: false })) {
        return;
      }
    } catch {
      complete = false;
      return;
    }
    const physicalMarker = resolveGitStoragePath(marker, paths, assertBudget);
    if (!physicalMarker) {
      complete = false;
      return;
    }
    try {
      bytes = readGitMetadataFile(physicalMarker);
    } catch {
      complete = false;
      return;
    }
    assertBudget();
    const nul = bytes.indexOf(0);
    if (nul >= 0) {
      complete = false;
      bytes = bytes.subarray(0, nul);
    }
    // Git odb.c adds direct alternates at depth 0 and stops after depth 5.
    if (depth >= 5) {
      return;
    }
    for (let offset = 0; offset < bytes.length;) {
      assertBudget();
      const newline = bytes.indexOf(10, offset);
      const lineEnd = newline < 0 ? bytes.length : newline;
      const comment = bytes[offset] === 35;
      const quoted = comment ? undefined : unquoteGitPath(bytes, offset);
      const entry = quoted?.bytes ?? bytes.subarray(offset, lineEnd);
      const end = quoted?.end ?? lineEnd;
      // Native parsing falls back to the literal line when C quoting is invalid.
      offset = end < bytes.length ? end + 1 : end;
      if (comment || entry.length === 0) {
        continue;
      }
      if (entry.includes(0) || !isUtf8(entry)) {
        complete = false;
        continue;
      }
      const pointer = entry.toString("utf8");
      visit(path.isAbsolute(pointer) ? pointer : `${directory}${path.sep}${pointer}`, depth + 1);
    }
  };
  visit(path.join(commonDir, "objects"), -1);
  assertBudget();
  return { paths: [...paths], complete };
}

function resolveGitHeadPath(startDir: string, opts: { maxDepth?: number } = {}): string | null {
  // Stricter than findGitRoot: keep walking until a resolvable git dir is found.
  return walkUpFrom(startDir, opts, (repoRoot) => {
    const gitDir = resolveGitDirFromMarker(repoRoot);
    return gitDir ? path.join(gitDir, "HEAD") : null;
  });
}

/** Read at most `limit` bytes from Git or build metadata. */
export function readGitMetadataPrefix(filePath: string, limit = 256): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytesRead = readFileWindowFullySync(fd, buf, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readGitHead(
  startDir: string,
  opts: { maxDepth?: number } = {},
): { headPath: string; ref: string | null; value: string | null; refsBase?: string } | undefined {
  const headPath = resolveGitHeadPath(startDir, opts);
  if (!headPath) {
    return undefined;
  }
  const head = fs.readFileSync(headPath, "utf-8").trim();
  if (!head.startsWith("ref:")) {
    return { headPath, ref: null, value: head || null };
  }
  const ref = head.replace(/^ref:\s*/i, "").trim();
  const refsBase = resolveGitRefsBase(headPath);
  return { headPath, ref, value: readGitRefs(refsBase, [ref]).get(ref) ?? null, refsBase };
}

export function resolveGitRefsBase(headPath: string): string {
  const gitDir = path.dirname(headPath);
  const marker = path.join(gitDir, "commondir");
  try {
    return readGitDirectoryPointer(marker);
  } catch (error) {
    if (!isMissingPathError(error) || fs.lstatSync(marker, { throwIfNoEntry: false })) {
      throw error;
    }
    // Plain repo git dirs do not have commondir.
  }
  return gitDir;
}

/** Raw ref contents, sharing one packed inventory across the requested names. */
export function readGitRefs(refsBase: string, refs: readonly string[]): Map<string, string | null> {
  const values = new Map<string, string | null>(refs.map((ref) => [ref, null]));
  const missing = new Set<string>();
  for (const ref of refs) {
    const refPath = resolveRefPath(refsBase, ref);
    if (!refPath) {
      continue;
    }
    try {
      values.set(ref, readGitMetadataPrefix(refPath).trim());
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      missing.add(ref);
    }
  }
  if (missing.size === 0) {
    return values;
  }
  try {
    const packedRefs = fs.readFileSync(path.join(refsBase, "packed-refs"), "utf-8");
    for (const line of packedRefs.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }
      const [value, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef && missing.delete(packedRef)) {
        values.set(packedRef, value ?? null);
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return values;
}

/** Safely resolve a Git ref path, rejecting traversal from a crafted HEAD file. */
function resolveRefPath(refsBase: string, ref: string): string | null {
  if (!ref.startsWith("refs/")) {
    return null;
  }
  if (path.isAbsolute(ref)) {
    return null;
  }
  if (ref.split(/[/]/).includes("..")) {
    return null;
  }
  const resolved = path.resolve(refsBase, ref);
  const rel = path.relative(refsBase, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
