import { compileFunction } from "node:vm";
import { STAGED_INPUT_PATHS_JS } from "../../media/staged-inputs.js";
import {
  MATERIALIZED_SANDBOX_SKILLS_WORKSPACE,
  MANAGED_SANDBOX_SKILLS_PATH_JS,
} from "../../shared/sandbox-workspace-paths.js";

const DERIVED_WORKSPACE_DIRECTORY_NAMES = [
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
] as const;

// These producers own exact checkout-relative roots, not every .cache or .artifacts path.
const BUILD_CACHE_ROOT_PATHS = [
  ".artifacts/build-all-cache",
  ".artifacts/build-cache-inputs",
] as const;
const PNPM_FALLBACK_STORE_ROOT_PATH = ".openclaw/.pnpm-store";
const DERIVED_WORKSPACE_ROOT_PATHS = [
  ".cache/vitest",
  ".cache/bun-transpiler",
  ".cache/openclaw/bun",
  ".cache/ms-playwright",
  ".local/share/pnpm/store",
  // pnpm falls back here for projects beneath the protected .openclaw self-bind.
  PNPM_FALLBACK_STORE_ROOT_PATH,
  // Managed binary installers keep re-downloadable tools beneath the state directory.
  ".openclaw/tools",
  ".artifacts/vitest-workers",
  ".artifacts/vitest-worker-cache",
  ".artifacts/vitest-shard-timings.json",
] as const;
const RUNTIME_WORKSPACE_ROOT_PATHS = [".artifacts/dist-artifacts.lock", ".openclaw/tmp"] as const;

const DERIVED_WORKSPACE_FILE_NAMES = [".DS_Store"] as const;
const DERIVED_WORKSPACE_FILE_SUFFIXES = [".pyc", ".pyo"] as const;
export const WORKER_ATTACHMENT_DIRECTORY_PREFIX = "openclaw-inbound-";
const UUID_HEX = "[0-9a-f]";
// randomUUID creates lowercase UUIDv4 names. This exact character-class pattern
// has the same meaning in a regular expression and an rsync exclusion glob.
export const WORKER_ATTACHMENT_DIRECTORY_PATTERN =
  WORKER_ATTACHMENT_DIRECTORY_PREFIX +
  [
    UUID_HEX.repeat(8),
    UUID_HEX.repeat(4),
    `4${UUID_HEX.repeat(3)}`,
    `[89ab]${UUID_HEX.repeat(3)}`,
    UUID_HEX.repeat(12),
  ].join("-");

// Match a whole segment without splitting each inventory path. The negative
// class ends at a slash or the actual end, unlike "$" before a final newline.
const DERIVED_WORKSPACE_SEGMENT_PATTERN = `(?:^|/)(?:${[
  ...DERIVED_WORKSPACE_DIRECTORY_NAMES.map((name) => name.replaceAll(".", "\\.")),
  ...DERIVED_WORKSPACE_FILE_NAMES.map((name) => name.replaceAll(".", "\\.")),
  ...DERIVED_WORKSPACE_FILE_SUFFIXES.map((suffix) => `[^/]*${suffix.replaceAll(".", "\\.")}`),
  WORKER_ATTACHMENT_DIRECTORY_PATTERN,
].join("|")})(?![^/])`;

// Derived caches and runtime attachment copies are not workspace edits. Keep
// sync, manifest, divergence, apply, and recovery on this single predicate.
export const WORKSPACE_PATH_EXCLUSIONS_JS = `
${STAGED_INPUT_PATHS_JS}
${MANAGED_SANDBOX_SKILLS_PATH_JS}
const DERIVED_WORKSPACE_ROOT_PATHS = ${JSON.stringify(DERIVED_WORKSPACE_ROOT_PATHS)};
const PNPM_FALLBACK_STORE_ROOT_PATH = ${JSON.stringify(PNPM_FALLBACK_STORE_ROOT_PATH)};
const BUILD_CACHE_ROOT_PATHS = ${JSON.stringify(BUILD_CACHE_ROOT_PATHS)};
function isBuildCacheWorkspacePath(relativePath) {
  return BUILD_CACHE_ROOT_PATHS.some((root) => relativePath === root || relativePath.startsWith(root + "/"));
}
function buildCacheInputPaths(paths = []) {
  const retained = new Set();
  for (const entryPath of paths) {
    if (!isBuildCacheWorkspacePath(entryPath)) continue;
    const segments = entryPath.split("/");
    for (let index = 1; index <= segments.length; index++) retained.add(segments.slice(0, index).join("/"));
  }
  return retained;
}
const RUNTIME_WORKSPACE_ROOT_PATHS = ${JSON.stringify(RUNTIME_WORKSPACE_ROOT_PATHS)};
const DERIVED_WORKSPACE_SEGMENT_RE = new RegExp(${JSON.stringify(DERIVED_WORKSPACE_SEGMENT_PATTERN)});
function isRuntimeOwnedWorkspacePath(relativePath) {
  return relativePath === ".git" || relativePath.startsWith(".git/") ||
    relativePath.endsWith("/.git") || relativePath.includes("/.git/") ||
    isManagedSandboxSkillsPath(relativePath) || RUNTIME_WORKSPACE_ROOT_PATHS.some(
    (root) => relativePath === root || relativePath.startsWith(root + "/"),
  );
}
function isDerivedWorkspacePath(relativePath, retainedInput = false, excludeBuildCaches = false, includeLegacyPnpmStore = false) {
  if (isRuntimeOwnedWorkspacePath(relativePath)) {
    return true;
  }
  if (retainedInput) {
    return false;
  }
  if (excludeBuildCaches && isBuildCacheWorkspacePath(relativePath)) return true;
  if (DERIVED_WORKSPACE_ROOT_PATHS.some(
    (root) => (!includeLegacyPnpmStore || root !== PNPM_FALLBACK_STORE_ROOT_PATH) &&
      (relativePath === root || relativePath.startsWith(root + "/")),
  )) {
    return true;
  }
  return DERIVED_WORKSPACE_SEGMENT_RE.test(relativePath);
}
function projectWorkspaceEntries(entries, isRetainedInput, excludeBuildCaches = false) {
  const nonemptyDirectories = new Set();
  const retainedParents = new Set();
  const parent = (entryPath) => entryPath.slice(0, Math.max(0, entryPath.lastIndexOf("/")));
  for (const entry of entries) nonemptyDirectories.add(parent(entry.path));
  const eligible = [];
  // Children precede parents in this reverse walk of the sorted inventory.
  // Prune ancestry created only by excluded contents, but retain original empty directories.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      isDerivedWorkspacePath(entry.path, isRetainedInput(entry.path), excludeBuildCaches) ||
      (entry.type === "directory" && nonemptyDirectories.has(entry.path) && !retainedParents.has(entry.path))
    ) continue;
    eligible.push(entry);
    retainedParents.add(parent(entry.path));
  }
  return eligible.toReversed();
}`;

export const {
  isDerivedWorkspacePath,
  isRuntimeOwnedWorkspacePath,
  projectWorkspaceEntries,
  buildCacheInputPaths,
}: {
  isDerivedWorkspacePath: (
    relativePath: string,
    retainedInput?: boolean,
    excludeBuildCaches?: boolean,
    includeLegacyPnpmStore?: boolean,
  ) => boolean;
  isRuntimeOwnedWorkspacePath: (relativePath: string) => boolean;
  buildCacheInputPaths: (paths?: Iterable<string>) => Set<string>;
  projectWorkspaceEntries: <T extends { path: string; type: string }>(
    entries: readonly T[],
    isRetainedInput: (relativePath: string) => boolean,
    excludeBuildCaches?: boolean,
  ) => T[];
} = compileFunction(
  `${WORKSPACE_PATH_EXCLUSIONS_JS}\nreturn { isDerivedWorkspacePath, isRuntimeOwnedWorkspacePath, projectWorkspaceEntries, buildCacheInputPaths };`,
)();

export const DERIVED_WORKSPACE_RSYNC_EXCLUDES = [
  `/${MATERIALIZED_SANDBOX_SKILLS_WORKSPACE}`,
  ...DERIVED_WORKSPACE_ROOT_PATHS.map((root) => `/${root}`),
  ...RUNTIME_WORKSPACE_ROOT_PATHS.map((root) => `/${root}`),
  ...DERIVED_WORKSPACE_DIRECTORY_NAMES,
  ...DERIVED_WORKSPACE_FILE_NAMES,
  ...DERIVED_WORKSPACE_FILE_SUFFIXES.map((suffix) => `*${suffix}`),
  WORKER_ATTACHMENT_DIRECTORY_PATTERN,
] as const;

// Standalone node capture/reset scripts cannot import fs-safe. Read only the
// bounded regular marker, rejecting parent aliases and binding bytes to its inode.
export const WORKSPACE_STAGED_INPUT_OWNERSHIP_JS = String.raw`
const stagedInputOwnership = new Map();
function isStagedInput(relativePath) {
  const directory = stagedInputPathDirectory(relativePath);
  if (!directory) return false;
  if (stagedInputOwnership.has(directory)) return stagedInputOwnership.get(directory);
  let owned = false;
  let descriptor;
  try {
    let parent = root;
    for (const segment of directory.split("/")) {
      parent = path.join(parent, segment);
      const stats = fs.lstatSync(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    const marker = path.join(parent, ".gitignore");
    const before = fs.lstatSync(marker);
    if (!before.isFile() || before.nlink !== 1 || before.size !== STAGED_INPUT_GITIGNORE.length) return false;
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) return false;
    const bytes = Buffer.alloc(STAGED_INPUT_GITIGNORE.length + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fs.lstatSync(marker);
    owned = after.isFile() && after.nlink === 1 && after.dev === opened.dev && after.ino === opened.ino &&
      after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      fs.realpathSync(marker) === marker && length === STAGED_INPUT_GITIGNORE.length &&
      bytes.subarray(0, length).toString("utf8") === STAGED_INPUT_GITIGNORE;
  } catch {
    // An ignored project directory with an absent or unsafe marker is not an input.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    stagedInputOwnership.set(directory, owned);
  }
  return owned;
}`;
