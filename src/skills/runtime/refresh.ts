// Skill runtime refresh helpers reload active skill state and notify subscribers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import chokidar, { type FSWatcher } from "chokidar";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolvePluginSkillDirs } from "../loading/plugin-skills.js";
import {
  bumpSkillsSnapshotVersion,
  clearSkillsSnapshotVersionForWorkspace,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
} from "./refresh-state.js";
export {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  shouldRefreshSnapshotForVersion,
  type SkillsChangeEvent,
} from "./refresh-state.js";

type SkillsPathWatchState = {
  // chokidar watcher used on non-native platforms (Linux/Windows) and as the
  // fallback when a native recursive watcher can't attach. Null while a native
  // recursive watcher is covering this directory instead.
  watcher: FSWatcher | null;
  // Native recursive fs.watch (macOS only) plus a non-recursive parent-directory
  // watch that detects root replacement (`rm -rf root && mkdir root`) by inode.
  nativeMain: fs.FSWatcher | null;
  nativeParent: fs.FSWatcher | null;
  nativeInode: number | null;
  // Set on teardown so a watcher event that races teardown — or a stale callback
  // from a replaced native watcher — cannot re-attach onto this orphaned state and
  // leak an untracked watcher (which would re-create the #90578 fd leak). Mirrors
  // the memory watcher's `closed` guard.
  disposed: boolean;
  depth: number;
  debounceMs: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  readonly subscribers: Set<string>;
};

type WatchTarget = {
  path: string;
  depth: number;
  key: string;
};

type WatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};

const log = createSubsystemLogger("gateway/skills");
const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// Resolved nested skill watch roots are filesystem-derived. Cache them so the
// per-turn watcher reconciliation path stays cheap until config or watched
// filesystem changes require a fresh root scan.
const workspaceWatchTargetCache = new Map<string, WatchTargetCacheEntry>();
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;

// On macOS each native fs.watch is backed by an open file descriptor, so
// chokidar's per-file SKILL.md watchers accumulate one descriptor per installed
// skill and grow the gateway's FD count linearly until it hits the per-process
// limit (#90578). A single native recursive fs.watch per skill root replaces that
// per-file fan-out with one watcher per directory tree (FSEvents on macOS,
// ReadDirectoryChangesW on Windows) that still catches in-place SKILL.md edits,
// so the descriptor count stays flat regardless of skill count. Mirrors the
// memory watcher fix for the sibling bug (#86613), which gates on the same set.
//
// Linux is intentionally excluded: Node's `fs.watch(dir, { recursive: true })`
// watches every file there (inotify fan-out), so Linux keeps chokidar, which has
// no per-process fd leak either. chokidar also remains the fallback on every
// platform when a native watcher can't attach.
const NATIVE_RECURSIVE_SKILLS_WATCH_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);

const TEST_SKILLS_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.skillsNativeWatchFactory");

function nativeRecursiveSkillsWatchSupported(): boolean {
  return NATIVE_RECURSIVE_SKILLS_WATCH_PLATFORMS.has(process.platform);
}

// Indirection so tests can inject a fake native watch factory (the same pattern
// the memory watcher uses); production always returns the real fs.watch.
function resolveSkillsNativeWatchFactory(): typeof fs.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[
      TEST_SKILLS_NATIVE_WATCH_FACTORY_KEY
    ];
    if (typeof override === "function") {
      return override as typeof fs.watch;
    }
  }
  return fs.watch.bind(fs);
}

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

function resolveWatchTargets(workspaceDir: string, config?: OpenClawConfig): WatchTarget[] {
  const baseRoots: Array<{ path: string; source: string }> = [];
  if (workspaceDir.trim()) {
    baseRoots.push({ path: path.join(workspaceDir, "skills"), source: "openclaw-workspace" });
    baseRoots.push({
      path: path.join(workspaceDir, ".agents", "skills"),
      source: "agents-skills-project",
    });
  }
  baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
  baseRoots.push({
    path: path.join(os.homedir(), ".agents", "skills"),
    source: "agents-skills-personal",
  });
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  const pluginSkillDirs = resolvePluginSkillDirs({ workspaceDir, config });
  const allowedSymlinkTargetRealPaths = resolveAllowedSymlinkTargetRealPaths(config);
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  const cached = workspaceWatchTargetCache.get(workspaceDir);
  if (cached?.signature === signature) {
    return cached.targets;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillRootWatchTargets(targets, root.path, GROUPED_SKILLS_WATCH_DEPTH);
    addTrustedSymlinkSkillWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      root.path,
    );
    addTrustedSymlinkSkillWatchTargets(
      targets,
      path.join(root.path, "skills"),
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      root.path,
    );
  }
  for (const resolved of extraDirs) {
    const rootDepth =
      path.basename(resolved) === "skills"
        ? GROUPED_SKILLS_WATCH_DEPTH
        : CONFIGURED_ROOT_WATCH_DEPTH;
    addSkillRootWatchTargets(targets, resolved, rootDepth);
    addTrustedSymlinkSkillWatchTargets(
      targets,
      resolved,
      "openclaw-extra",
      allowedSymlinkTargetRealPaths,
      rootDepth,
      resolved,
    );
    addTrustedSymlinkSkillWatchTargets(
      targets,
      path.join(resolved, "skills"),
      "openclaw-extra",
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      resolved,
    );
  }
  for (const dir of pluginSkillDirs) {
    const rootDepth =
      path.basename(dir) === "skills" ? GROUPED_SKILLS_WATCH_DEPTH : CONFIGURED_ROOT_WATCH_DEPTH;
    addSkillRootWatchTargets(targets, dir, rootDepth);
    addTrustedSymlinkSkillWatchTargets(
      targets,
      dir,
      "openclaw-plugin",
      allowedSymlinkTargetRealPaths,
      rootDepth,
      dir,
    );
    addTrustedSymlinkSkillWatchTargets(
      targets,
      path.join(dir, "skills"),
      "openclaw-plugin",
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      dir,
    );
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) => a.key.localeCompare(b.key));
  workspaceWatchTargetCache.set(workspaceDir, { signature, targets: sortedTargets });
  return sortedTargets;
}

function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "") || normalized;
}

function makeWatchTarget(raw: string, depth: number): WatchTarget {
  const watchPath = toWatchRoot(raw);
  return { path: watchPath, depth, key: watchPath };
}

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target = makeWatchTarget(raw, depth);
  const existing = targets.get(target.key);
  if (existing) {
    existing.depth = Math.max(existing.depth, target.depth);
    return;
  }
  targets.set(target.key, target);
}

function addSkillRootWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  rootDepth: number,
): void {
  addWatchTarget(targets, root, watchDepthForPath(root, rootDepth));
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(
    targets,
    companionSkillsRoot,
    watchDepthForPath(companionSkillsRoot, GROUPED_SKILLS_WATCH_DEPTH),
  );
}

function addTrustedSymlinkSkillWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  maxDepth: number,
  containmentRoot: string,
): void {
  const containmentRootRealPath = tryRealpath(containmentRoot) ?? path.resolve(containmentRoot);
  const rootRealPath = tryRealpath(root) ?? path.resolve(root);
  try {
    if (
      fs.lstatSync(root).isSymbolicLink() &&
      isTrustedSymlinkSkillTarget(
        source,
        containmentRootRealPath,
        rootRealPath,
        allowedSymlinkTargetRealPaths,
      )
    ) {
      addSkillRootWatchTargets(targets, rootRealPath, maxDepth);
    }
  } catch {
    return;
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let watched = 0;
  let directoryScans = 0;
  let rawEntries = 0;
  for (const queued of queue) {
    if (
      watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT ||
      directoryScans >= MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT ||
      rawEntries >= MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT
    ) {
      break;
    }
    const current = queued;
    if (!current) {
      continue;
    }
    const scan = readBudgetedDirEntries(
      current.dir,
      MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT - rawEntries,
    );
    directoryScans += 1;
    rawEntries += scan.scannedEntryCount;
    if (!scan.ok) {
      continue;
    }
    for (const entry of scan.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT) {
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const childPath = path.join(current.dir, entry.name);
      if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(childPath))) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const targetRealPath = tryRealpath(childPath);
        if (
          targetRealPath &&
          isTrustedSymlinkSkillTarget(
            source,
            containmentRootRealPath,
            targetRealPath,
            allowedSymlinkTargetRealPaths,
          )
        ) {
          addSkillRootWatchTargets(targets, targetRealPath, GROUPED_SKILLS_WATCH_DEPTH);
          watched += 1;
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }
}

function readBudgetedDirEntries(
  dir: string,
  maxEntries: number,
):
  | { ok: true; entries: fs.Dirent[]; scannedEntryCount: number }
  | { ok: false; scannedEntryCount: number } {
  const entries: fs.Dirent[] = [];
  const limit = Math.max(0, maxEntries);
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let scanned = 0; scanned < limit; scanned += 1) {
      const entry = handle.readSync();
      if (!entry) {
        return { ok: true, entries, scannedEntryCount: scanned };
      }
      entries.push(entry);
    }
    return { ok: true, entries, scannedEntryCount: limit };
  } catch {
    return { ok: false, scannedEntryCount: 0 };
  } finally {
    handle?.closeSync();
  }
}

function isTrustedSymlinkSkillTarget(
  source: string,
  rootRealPath: string,
  targetRealPath: string,
  allowedSymlinkTargetRealPaths: readonly string[],
): boolean {
  if (source === "openclaw-managed" || source === "agents-skills-personal") {
    return true;
  }
  return (
    isPathInside(rootRealPath, targetRealPath) ||
    isPathInsideAnyRoot(allowedSymlinkTargetRealPaths, targetRealPath)
  );
}

function watchDepthForPath(raw: string, depth: number): number {
  let missingSegments = 0;
  let candidate = raw;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    missingSegments += 1;
    candidate = parent;
  }
  return depth + missingSegments;
}

function resolveAllowedSymlinkTargetRealPaths(config?: OpenClawConfig): string[] {
  const rawTargets = config?.skills?.load?.allowSymlinkTargets ?? [];
  return rawTargets
    .map((dir) => normalizeOptionalString(dir) ?? "")
    .filter(Boolean)
    .map((dir) => tryRealpath(resolveUserPath(dir)))
    .filter((dir): dir is string => Boolean(dir));
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isPathInsideAnyRoot(roots: readonly string[], child: string): boolean {
  return roots.some((root) => isPathInside(root, child));
}

export function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const normalized = watchPath.replaceAll("\\", "/");
  return path.posix.basename(normalized) !== "SKILL.md";
}

function resolveWatchDebounceMs(config?: OpenClawConfig): number {
  const raw = config?.skills?.load?.watchDebounceMs;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 250;
}

// Requires resolveWatchTargets to produce a stable-order result (it returns a
// sorted array); positional comparison is intentional for hot-path efficiency.
function sameWatchTargets(a: WatchTarget[], b: WatchTarget[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    if (a[index]?.key !== b[index]?.key || a[index]?.depth !== b[index]?.depth) {
      return false;
    }
  }
  return true;
}

function makeSkillsWatchSchedule(
  state: SkillsPathWatchState,
  debounceMs: number,
): (changedPath?: string) => void {
  return (changedPath?: string) => {
    if (state.disposed) {
      return;
    }
    state.pendingPath = changedPath ?? state.pendingPath;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      const pendingPath = state.pendingPath;
      state.pendingPath = undefined;
      state.timer = undefined;
      // Fan the change out to every workspace subscribed to this directory so a
      // shared skill root refreshes the snapshot for all agents that use it.
      for (const workspaceDir of state.subscribers) {
        workspaceWatchTargetCache.delete(workspaceDir);
        bumpSkillsSnapshotVersion({
          workspaceDir,
          reason: "watch",
          changedPath: pendingPath,
        });
      }
    }, debounceMs);
  };
}

function attachChokidarSkillsWatch(
  state: SkillsPathWatchState,
  target: WatchTarget,
  debounceMs: number,
  schedule: (changedPath?: string) => void,
): void {
  // Idempotent + disposed-guarded: never replace a live chokidar watcher (which
  // would leak the previous one) and never attach onto a torn-down state.
  if (state.disposed || state.watcher) {
    return;
  }
  const watcher = chokidar.watch(target.path, {
    ignoreInitial: true,
    followSymlinks: false,
    // Skill root precedence and grouped discovery use the same bounded depth,
    // so watcher invalidation must observe that whole decision surface.
    depth: target.depth,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    ignored: shouldIgnoreSkillsWatchPath,
  });
  state.watcher = watcher;
  watcher.on("add", (p) => schedule(p));
  watcher.on("change", (p) => schedule(p));
  watcher.on("unlink", (p) => schedule(p));
  watcher.on("unlinkDir", (p) => schedule(p));
  watcher.on("error", (err) => {
    log.warn(`skills watcher error (${target.path}): ${String(err)}`);
  });
}

function closeNativeSkillsWatchers(state: SkillsPathWatchState): void {
  if (state.nativeMain) {
    try {
      state.nativeMain.close();
    } catch {
      // ignore close failures
    }
    state.nativeMain = null;
  }
  if (state.nativeParent) {
    try {
      state.nativeParent.close();
    } catch {
      // ignore close failures
    }
    state.nativeParent = null;
  }
  state.nativeInode = null;
}

// Attach one native recursive fs.watch to the skill root (macOS only) plus a
// non-recursive parent-directory watch that detects root replacement
// (`rm -rf root && mkdir root`) by inode comparison. Returns true when the main
// native watcher attached; false (leaving no native state behind) when the
// caller should fall back to chokidar. Mirrors the memory watcher house pattern.
function attachNativeSkillsRecursiveWatch(
  state: SkillsPathWatchState,
  target: WatchTarget,
  schedule: (changedPath?: string) => void,
  debounceMs: number,
): boolean {
  // Don't attach onto a torn-down state, or alongside an active chokidar fallback
  // (native and chokidar coverage for one root are mutually exclusive).
  if (state.disposed || state.watcher) {
    return false;
  }
  let recordedInode: number;
  try {
    recordedInode = fs.statSync(target.path).ino;
  } catch {
    // Root doesn't exist yet; fall back to chokidar, which can watch a
    // not-yet-created path and pick it up once it appears.
    return false;
  }
  let mainWatcher: fs.FSWatcher;
  try {
    mainWatcher = resolveSkillsNativeWatchFactory()(
      target.path,
      { recursive: true },
      (_eventType, filename) => {
        if (filename == null) {
          // filename can be null on some platforms even when recursive watching
          // works; refresh broadly rather than dropping the event.
          schedule();
          return;
        }
        const full = path.join(target.path, filename);
        // Preserve chokidar's depth bound on the native path: native recursive
        // watches the whole tree, so ignore events deeper than the watch target
        // would have traversed.
        const relativeSegments = path.relative(target.path, full).split(path.sep);
        if (relativeSegments.length - 1 > target.depth) {
          return;
        }
        let stats: fs.Stats | undefined;
        try {
          stats = fs.lstatSync(full, { throwIfNoEntry: false }) ?? undefined;
        } catch {
          stats = undefined;
        }
        if (shouldIgnoreSkillsWatchPath(full, stats)) {
          return;
        }
        schedule(full);
      },
    );
  } catch (err) {
    log.warn(
      `skills native watcher could not start on ${target.path}: ${String(err)}; falling back to chokidar`,
    );
    return false;
  }
  state.nativeMain = mainWatcher;
  state.nativeInode = recordedInode;
  mainWatcher.on("error", (err) => {
    // Ignore a stale error from a watcher this state no longer owns (replaced by a
    // reattach) or after teardown; otherwise we'd re-attach onto a dead state.
    if (state.disposed || state.nativeMain !== mainWatcher) {
      return;
    }
    log.warn(`skills native watcher error (${target.path}): ${String(err)}`);
    // Per Node docs an FSWatcher is unusable after an error. Tear down, force a
    // refresh to cover the gap, then restore coverage with chokidar.
    closeNativeSkillsWatchers(state);
    schedule();
    attachChokidarSkillsWatch(state, target, debounceMs, schedule);
  });
  // Non-recursive parent watch: catches root replacement so the main watcher can
  // reattach on the new inode instead of silently watching the dead one.
  try {
    const parentDir = path.dirname(target.path);
    const baseName = path.basename(target.path);
    const parentWatcher = resolveSkillsNativeWatchFactory()(
      parentDir,
      { recursive: false },
      (_eventType, filename) => {
        // Ignore a stale parent event after this watcher was replaced or the state
        // was torn down, so we don't reattach onto an orphaned/superseded state.
        if (state.disposed || state.nativeParent !== parentWatcher) {
          return;
        }
        // filename can be null on some platforms; otherwise filter by basename so
        // sibling churn in the parent directory doesn't trigger a reattach.
        if (filename !== null && filename !== baseName) {
          return;
        }
        let currentInode: number | null;
        try {
          currentInode = fs.statSync(target.path).ino;
        } catch {
          currentInode = null;
        }
        if (currentInode === state.nativeInode) {
          return;
        }
        // Root was replaced or removed: tear down, force a refresh, then reattach
        // natively on the new inode (or fall back to chokidar if it's gone).
        closeNativeSkillsWatchers(state);
        schedule();
        if (currentInode !== null) {
          if (!attachNativeSkillsRecursiveWatch(state, target, schedule, debounceMs)) {
            attachChokidarSkillsWatch(state, target, debounceMs, schedule);
          }
        } else {
          attachChokidarSkillsWatch(state, target, debounceMs, schedule);
        }
      },
    );
    parentWatcher.on("error", (err) => {
      log.warn(`skills native parent watcher error (${parentDir}): ${String(err)}`);
      try {
        parentWatcher.close();
      } catch {
        // ignore close failures
      }
      if (state.nativeParent === parentWatcher) {
        state.nativeParent = null;
      }
      // Main watcher still alive — only root-replacement detection is lost.
    });
    state.nativeParent = parentWatcher;
  } catch (err) {
    log.warn(`skills native parent watcher could not start on ${target.path}: ${String(err)}`);
  }
  return true;
}

function createSkillsPathWatcher(target: WatchTarget, debounceMs: number): SkillsPathWatchState {
  const state: SkillsPathWatchState = {
    watcher: null,
    nativeMain: null,
    nativeParent: null,
    nativeInode: null,
    disposed: false,
    depth: target.depth,
    debounceMs,
    subscribers: new Set<string>(),
  };
  const schedule = makeSkillsWatchSchedule(state, debounceMs);
  // macOS leaks one descriptor per native file watcher, so use a single native
  // recursive watcher per skill root there (#90578). Every other platform keeps
  // chokidar, which also serves as the fallback if native attach fails.
  if (
    nativeRecursiveSkillsWatchSupported() &&
    attachNativeSkillsRecursiveWatch(state, target, schedule, debounceMs)
  ) {
    return state;
  }
  attachChokidarSkillsWatch(state, target, debounceMs, schedule);
  return state;
}

function teardownSkillsPathWatcher(state: SkillsPathWatchState): void {
  state.disposed = true;
  if (state.timer) {
    clearTimeout(state.timer);
  }
  closeNativeSkillsWatchers(state);
  if (state.watcher) {
    void state.watcher.close().catch(() => {});
  }
}

function subscribeWorkspaceToPath(
  workspaceDir: string,
  watchTarget: WatchTarget,
  debounceMs: number,
): void {
  const existing = pathWatchers.get(watchTarget.key);
  if (existing && existing.debounceMs === debounceMs && existing.depth >= watchTarget.depth) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // Debounce changed (config reload): rebuild the shared watcher while
    // preserving existing subscribers. Debounce is a gateway-global config
    // value, so all workspaces normally request the same value and this branch
    // does not fire; if it does, the most recent requested debounce wins for
    // every subscriber of the shared path (last-writer-wins).
    const next = createSkillsPathWatcher(
      { ...watchTarget, depth: Math.max(existing.depth, watchTarget.depth) },
      debounceMs,
    );
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
    }
    next.subscribers.add(workspaceDir);
    teardownSkillsPathWatcher(existing);
    pathWatchers.set(watchTarget.key, next);
    return;
  }
  const state = createSkillsPathWatcher(watchTarget, debounceMs);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.key, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.key);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    teardownSkillsPathWatcher(state);
    pathWatchers.delete(watchTarget.key);
  }
}

function disposeWorkspaceWatchState(
  workspaceDir: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(workspaceDir) ?? [],
): void {
  const hadWatchTargets = watchTargets.length > 0;
  for (const watchTarget of watchTargets) {
    unsubscribeWorkspaceFromPath(workspaceDir, watchTarget);
  }
  workspaceWatchTargets.delete(workspaceDir);
  workspaceWatchTargetCache.delete(workspaceDir);
  workspaceWatchLastEnsuredAt.delete(workspaceDir);
  if (hadWatchTargets) {
    // Watcher disposal creates an unwatched interval; mark the workspace dirty
    // so the next turn rebuilds skills even if file events were missed.
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch-targets" });
  }
  clearSkillsSnapshotVersionForWorkspace(workspaceDir);
}

function evictIdleWorkspaceWatchStates(now: number): void {
  const cutoff = now - SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS;
  for (const [workspaceDir, lastEnsuredAt] of workspaceWatchLastEnsuredAt) {
    if (lastEnsuredAt < cutoff) {
      disposeWorkspaceWatchState(workspaceDir);
    }
  }
}

export function ensureSkillsWatcher(params: { workspaceDir: string; config?: OpenClawConfig }) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const now = Date.now();
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const debounceMs = resolveWatchDebounceMs(params.config);
  const previousTargets = workspaceWatchTargets.get(workspaceDir) ?? [];

  if (!watchEnabled) {
    disposeWorkspaceWatchState(workspaceDir, previousTargets);
    evictIdleWorkspaceWatchStates(now);
    return;
  }

  workspaceWatchLastEnsuredAt.set(workspaceDir, now);
  const watchTargets = resolveWatchTargets(workspaceDir, params.config);
  const targetsUnchanged = sameWatchTargets(previousTargets, watchTargets);
  const debounceUnchanged = watchTargets.every(
    // undefined for paths not yet watched -> false -> fall through to subscribe.
    (watchTarget) => {
      const pathWatcher = pathWatchers.get(watchTarget.key);
      return pathWatcher?.debounceMs === debounceMs && pathWatcher.depth >= watchTarget.depth;
    },
  );
  if (targetsUnchanged && debounceUnchanged) {
    evictIdleWorkspaceWatchStates(now);
    return;
  }
  const watchTargetsChanged = previousTargets.length > 0 && !targetsUnchanged;

  const nextTargetKeys = new Set(watchTargets.map((target) => target.key));
  for (const watchTarget of previousTargets) {
    if (!nextTargetKeys.has(watchTarget.key)) {
      unsubscribeWorkspaceFromPath(workspaceDir, watchTarget);
    }
  }
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(workspaceDir, watchTarget, debounceMs);
  }
  workspaceWatchTargets.set(workspaceDir, watchTargets);

  if (watchTargetsChanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
  evictIdleWorkspaceWatchStates(now);
}

export async function resetSkillsRefreshForTest(): Promise<void> {
  resetSkillsRefreshStateForTest();

  const active = Array.from(pathWatchers.values());
  pathWatchers.clear();
  workspaceWatchTargets.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  await Promise.all(
    active.map(async (state) => {
      state.disposed = true;
      if (state.timer) {
        clearTimeout(state.timer);
      }
      closeNativeSkillsWatchers(state);
      if (state.watcher) {
        try {
          await state.watcher.close();
        } catch {
          // Best-effort test cleanup.
        }
      }
    }),
  );
}
