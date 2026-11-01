import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";
import { isPathInside } from "./path-guards.js";
import type { DecideDatabaseSnapshot } from "./update-database-snapshot-custody.js";
import { isGitDatabaseSnapshotName } from "./update-runtime-staging.js";

const log = createSubsystemLogger("infra:temp-artifacts");
const retainedRuntimes = resolveGlobalSingleton(
  Symbol.for("openclaw.retainedUpdateRuntimes"),
  () => new Set<string>(),
);
const UPDATE_ARTIFACT_OWNER_FILE = ".openclaw-update-owner.json";
const UPDATE_ARTIFACT_REMOVING_SUFFIX = ".removing";
const UPDATE_ARTIFACT_SWEEP_BUDGET_MS = 10_000;
// Longer than any update run, so age stands in for owner and holder facts a host cannot provide.
const UNPROVEN_UPDATE_ARTIFACT_RETENTION_HOURS = 24;
// A failed census on a host that can usually answer is nearly always transient, and the next
// sweep decides. This only ends retention on a host where it keeps failing.
const FAILED_CENSUS_UPDATE_ARTIFACT_RETENTION_HOURS = 7 * 24;
const HOUR_MS = 60 * 60 * 1000;

type UpdateArtifactOwner = { pid: number; startTime: number | null };

/** Registration lasts through worker settlement, including failed update reporting. */
export function registerRetainedUpdateRuntime(directory: string): () => void {
  retainedRuntimes.add(directory);
  return () => void retainedRuntimes.delete(directory);
}

/**
 * Register an update's scratch directory here and record it for other processes.
 * A failed record only delays reclamation until the artifact is old enough.
 */
export async function claimUpdateArtifact(directory: string): Promise<() => void> {
  let release = registerRetainedUpdateRuntime(directory);
  try {
    // The sweep looks this up by native spelling; macOS's default TMPDIR is a symlinked path.
    release();
    release = registerRetainedUpdateRuntime(resolveIdentityPathViaExistingAncestorSync(directory));
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    await fs.writeFile(
      path.join(directory, UPDATE_ARTIFACT_OWNER_FILE),
      JSON.stringify({
        pid: process.pid,
        startTime: getFileLockProcessStartTime(process.pid),
      } satisfies UpdateArtifactOwner),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    log.warn(`Could not record the owner of ${directory}: ${formatErrorMessage(error)}`);
  }
  return () => release();
}

export function resolveWindowsUpdatePreflightBaseDirectory(): string {
  return path.win32.join(process.env.SystemDrive ?? "C:", "ocu");
}

export function reportRetainedUpdateRuntime(
  directory: string,
  reason: string,
  label = "Runtime",
): string {
  const message = `${label} retained at ${directory}: ${reason}`;
  try {
    log.warn(message);
  } catch {
    // The caller still records the warning.
  }
  return message;
}

/** Placement and discovery share the climb outside the enclosing module owner. */
export function resolveRetainedUpdateRuntimeParents(
  packageRoot: string,
  mutationRoots: readonly string[] = [],
): string[] {
  const parts = packageRoot.split(path.sep);
  const modules = parts.indexOf("node_modules");
  const boundaries = [
    parts.slice(0, modules >= 0 ? modules + 1 : parts.length).join(path.sep),
    ...mutationRoots,
  ];
  let parent = path.dirname(packageRoot);
  const parents = [parent];
  while (boundaries.some((root) => isPathInside(root, parent))) {
    const ancestor = path.dirname(parent);
    if (ancestor === parent) {
      break;
    }
    parent = ancestor;
    parents.push(parent);
  }
  return parents;
}

async function isRetainedRuntimeMarker(marker: string): Promise<boolean> {
  if ((await fs.realpath(marker).catch(() => undefined)) !== marker) {
    return false;
  }
  const value: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
  return isRecord(value) && value.name === "openclaw";
}

async function recognizesRetainedRuntime(directory: string, packageRoot: string): Promise<boolean> {
  const base = path.parse(packageRoot).root;
  const tree = path.join(directory, "tree", Buffer.from(base).toString("hex"));
  const projectedRoot = path.join(tree, path.relative(base, packageRoot));
  if (await isRetainedRuntimeMarker(path.join(projectedRoot, "package.json"))) {
    return true;
  }
  // Shipped projections encode the old source path, not the currently installed
  // pnpm version. Search only sibling package versions in that same projected store.
  const modules = path.dirname(projectedRoot);
  const version = path.dirname(modules);
  const store = path.dirname(version);
  if (
    path.basename(projectedRoot) !== "openclaw" ||
    path.basename(modules) !== "node_modules" ||
    !path.basename(version).startsWith("openclaw@") ||
    path.basename(store) !== ".pnpm" ||
    (await fs.realpath(store).catch(() => undefined)) !== store
  ) {
    return false;
  }
  let inspected = 0;
  for await (const entry of await fs.opendir(store)) {
    // A normal dependency store can contain well over a thousand entries.
    if (++inspected > 4096) {
      throw new Error(
        "retained pnpm version inventory exceeds the bounded lookup; inspect it before manual cleanup",
      );
    }
    if (
      entry.isDirectory() &&
      entry.name.startsWith("openclaw@") &&
      (await isRetainedRuntimeMarker(
        path.join(store, entry.name, "node_modules/openclaw/package.json"),
      ))
    ) {
      return true;
    }
  }
  return false;
}

type UpdateArtifactKind = {
  label: string;
  removed: string;
  pattern: Pick<RegExp, "test">;
  /** Pre-migration data: its update's outcome, not a process owner, decides. */
  databaseSnapshot?: true;
  /** Top-level entries a prior run leaves behind, for directories without an owner record. */
  entries?: readonly string[];
};

const updateArtifactKinds: readonly UpdateArtifactKind[] = [
  {
    label: "Runtime",
    removed: "updater runtime",
    pattern: /^openclaw-update-runtime-[A-Za-z0-9]{6}$/u,
  },
  {
    label: "Update preflight worktree",
    removed: "update preflight worktree",
    pattern: /^(?:\.openclaw-update-preflight-|ocu-pf-)[A-Za-z0-9]{6}$/u,
    entries: ["worktree", "wt"],
  },
  {
    label: "Update inspection repository",
    removed: "update inspection repository",
    pattern: /^openclaw-git-admission-[A-Za-z0-9]{6}$/u,
    entries: ["repository.git"],
  },
  {
    label: "Update database snapshot",
    removed: "update database snapshot",
    pattern: { test: isGitDatabaseSnapshotName },
    databaseSnapshot: true,
  },
];

async function readUpdateArtifactOwner(
  directory: string,
): Promise<UpdateArtifactOwner | undefined> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(directory, UPDATE_ARTIFACT_OWNER_FILE), "utf8"),
    );
    return isRecord(value) && typeof value.pid === "number" && Number.isSafeInteger(value.pid)
      ? {
          pid: value.pid,
          startTime: typeof value.startTime === "number" ? value.startTime : null,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function isUpdateArtifactOwnerActive(
  owner: UpdateArtifactOwner,
  ageMs: number,
): Promise<boolean> {
  // In this process the registry is the authority: release means the owner is done.
  if (owner.pid === process.pid) {
    return false;
  }
  const { getFileLockProcessStartTime, isPidDefinitelyDead } =
    await import("../shared/pid-alive.js");
  if (isPidDefinitelyDead(owner.pid)) {
    return false;
  }
  const startTime = getFileLockProcessStartTime(owner.pid);
  // A live PID with no comparable identity may be a reused one, so its protection expires.
  return owner.startTime !== null && startTime !== null
    ? owner.startTime === startTime
    : ageMs < UNPROVEN_UPDATE_ARTIFACT_RETENTION_HOURS * HOUR_MS;
}

async function recognizesUpdateArtifact(
  kind: UpdateArtifactKind,
  directory: string,
  packages: readonly string[],
): Promise<boolean> {
  if (kind.databaseSnapshot) {
    return true;
  }
  if (kind.entries) {
    const entries = await fs.readdir(directory);
    return entries.every((entry) => kind.entries?.includes(entry));
  }
  for (const packageRoot of packages) {
    if (await recognizesRetainedRuntime(directory, packageRoot)) {
      return true;
    }
  }
  return false;
}

/**
 * Update artifacts are disposable once nothing uses them. Keep one for its live owning
 * run or a process actually using its path, never for merely sharing a host with OpenClaw.
 * Missing evidence means age decides, with a warning, and cleanup never fails the caller.
 */
export async function maintainRetainedUpdateRuntimes(params: {
  packageRoots: readonly string[];
  temporaryDirectories?: readonly string[];
  repair: boolean;
  assertCurrent: () => void;
  assertResourcesSettled?: () => void;
  onWarning?: (warning: string) => void;
  /** Snapshots stay out of this sweep unless the caller can read their update's outcome. */
  decideDatabaseSnapshot?: DecideDatabaseSnapshot;
  /** Bounds how long the caller waits; started removals finish in the background. */
  budgetMs?: number;
}): Promise<string[]> {
  const messages: string[] = [];
  const warn = (message: string) => {
    messages.push(message);
    params.onWarning?.(message);
  };
  const deadline = Date.now() + (params.budgetMs ?? UPDATE_ARTIFACT_SWEEP_BUDGET_MS);
  const removals: {
    kind: UpdateArtifactKind;
    directory: string;
    finished?: true;
    failure?: string;
    settled: Promise<void>;
  }[] = [];
  let waited = false;
  const remove = (kind: UpdateArtifactKind, directory: string, target: string) => {
    const removal: (typeof removals)[number] = { kind, directory, settled: Promise.resolve() };
    removal.settled = removeTemporaryArtifacts(target, kind.removed, (error) => {
      removal.failure = `cleanup failed: ${formatErrorMessage(error)}`;
      if (waited) {
        // Nobody reads the result after the caller moved on; the next sweep retries.
        reportRetainedUpdateRuntime(directory, removal.failure, kind.label);
      }
    }).then(() => {
      removal.finished = true;
    });
    removals.push(removal);
  };
  // Native spelling matches the projection, registration, and marker realpaths
  // even when callers pass a Windows 8.3 or differently cased spelling.
  const packages = params.packageRoots.map(resolveIdentityPathViaExistingAncestorSync);
  const roots = new Set(
    [
      os.tmpdir(),
      ...(params.temporaryDirectories ?? []),
      ...packages.flatMap((root) => [
        ...resolveRetainedUpdateRuntimeParents(root),
        path.join(root, ".artifacts"),
      ]),
      ...(process.platform === "win32" ? [resolveWindowsUpdatePreflightBaseDirectory()] : []),
    ].map(resolveIdentityPathViaExistingAncestorSync),
  );
  let inspected = 0;
  for (const parent of roots) {
    try {
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        const name = entry.name.endsWith(UPDATE_ARTIFACT_REMOVING_SUFFIX)
          ? entry.name.slice(0, -UPDATE_ARTIFACT_REMOVING_SUFFIX.length)
          : entry.name;
        const kind = updateArtifactKinds.find(({ pattern }) => pattern.test(name));
        if (!kind || (kind.databaseSnapshot && !params.decideDatabaseSnapshot)) {
          continue;
        }
        const directory = path.join(parent, name);
        try {
          if (inspected++ > 0 && Date.now() >= deadline) {
            messages.push(
              `${kind.label} at ${directory} waits for a later update: this cleanup pass reached its time limit`,
            );
            continue;
          }
          const before = await fs.lstat(path.join(parent, entry.name));
          if (!before.isDirectory() || (process.getuid && before.uid !== process.getuid())) {
            throw new Error("directory ownership is unknown; inspect it before manual cleanup");
          }
          if (name !== entry.name) {
            // A renamed artifact already passed these checks; an earlier removal stopped midway.
            if (params.repair) {
              remove(kind, directory, path.join(parent, entry.name));
            }
            continue;
          }
          const keep = (reason: string) =>
            messages.push(reportRetainedUpdateRuntime(directory, reason, kind.label));
          if (retainedRuntimes.has(directory)) {
            keep("the creating update still owns this runtime");
            continue;
          }
          const owner = await readUpdateArtifactOwner(directory);
          if (!owner && !(await recognizesUpdateArtifact(kind, directory, packages))) {
            throw new Error("no recognized runtime marker; inspect it before manual cleanup");
          }
          if (!params.repair) {
            messages.push(
              `${kind.label} retained at ${directory}: run \`openclaw doctor --fix\` after its workers stop`,
            );
            continue;
          }
          const ageMs = Date.now() - before.mtimeMs;
          const snapshot = kind.databaseSnapshot
            ? params.decideDatabaseSnapshot?.(directory, ageMs)
            : undefined;
          if (snapshot && "keep" in snapshot) {
            keep(snapshot.keep);
            continue;
          }
          if (owner && (await isUpdateArtifactOwnerActive(owner, ageMs))) {
            keep(`its owning update is still running (PID ${owner.pid})`);
            continue;
          }
          const { inspectOtherOpenClawProcesses } = await import("./openclaw-process-census.js");
          const current = await fs.lstat(directory);
          if (
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            current.ctimeMs !== before.ctimeMs ||
            retainedRuntimes.has(directory)
          ) {
            throw new Error("directory identity or custody changed");
          }
          params.assertCurrent();
          const census = inspectOtherOpenClawProcesses(directory);
          for (const warning of "error" in census ? [] : (census.warnings ?? [])) {
            if (!messages.includes(warning)) {
              messages.push(warning);
            }
          }
          if (!("error" in census) && census.pids.length) {
            keep(
              `processes are still using it (PIDs: ${census.pids.join(", ")}); let these holders finish, then rerun openclaw doctor --fix, or the next update reclaims it`,
            );
            continue;
          }
          const unproven =
            "error" in census
              ? census.error
              : (census.incomplete ??
                (owner || snapshot ? undefined : "it records no owning update"));
          if (snapshot) {
            if (unproven) {
              // Age never overrides missing holder evidence for the only copy of this data.
              warn(reportRetainedUpdateRuntime(directory, unproven, kind.label));
              continue;
            }
            const reason = `Removing ${kind.removed} ${directory}: ${snapshot.remove}`;
            log.info(reason);
            messages.push(reason);
          } else if (unproven) {
            const hours =
              "error" in census
                ? FAILED_CENSUS_UPDATE_ARTIFACT_RETENTION_HOURS
                : UNPROVEN_UPDATE_ARTIFACT_RETENTION_HOURS;
            if (ageMs < hours * HOUR_MS) {
              warn(
                reportRetainedUpdateRuntime(
                  directory,
                  `${unproven}; keeping it until it is ${hours} hours old`,
                  kind.label,
                ),
              );
              continue;
            }
            const byAge = `Removing ${kind.removed} ${directory} by age: ${unproven}, and it is over ${hours} hours old`;
            log.warn(byAge);
            warn(byAge);
          }
          params.assertResourcesSettled?.();
          params.assertCurrent();
          // Rename first: an in-use Windows tree refuses as a whole instead of partially
          // deleting, and an interrupted removal stays recognizable to the next sweep.
          const removing = `${directory}${UPDATE_ARTIFACT_REMOVING_SUFFIX}`;
          await fs.rename(directory, removing);
          remove(kind, directory, removing);
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            warn(reportRetainedUpdateRuntime(directory, formatErrorMessage(error), kind.label));
          }
        }
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        const message = `Cannot inspect updater runtimes in ${parent}: ${formatErrorMessage(error)}`;
        log.warn(message);
        warn(message);
      }
    }
  }
  if (removals.length) {
    await raceWithTimeout(
      Promise.all(removals.map(({ settled }) => settled)),
      Math.max(0, deadline - Date.now()),
      () => undefined,
    );
    waited = true;
  }
  for (const { kind, directory, finished, failure } of removals) {
    if (failure) {
      warn(reportRetainedUpdateRuntime(directory, failure, kind.label));
      continue;
    }
    const outcome = finished
      ? `Removed abandoned ${kind.removed}: ${directory}`
      : `Removing abandoned ${kind.removed} in the background: ${directory}`;
    log.info(outcome);
    messages.push(outcome);
  }
  return messages;
}

// Only disposable filesystem artifacts are advisory. Call after resource release;
// failed deletion must preserve the primary result, including cancellation/timeouts.
export function removeTemporaryArtifacts(
  directory: string,
  owner: string,
  onError: (error: unknown) => void = (error) =>
    log.warn(
      truncateUtf16Safe(
        formatErrorMessage(
          `${owner} cleanup failed; files may remain in ${directory}. After the worker or session stops, check permissions and remove the retained directory: ${formatErrorMessage(error)}`,
        ),
        1_024,
      ),
    ),
): Promise<void> {
  return runBestEffortCleanup({
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    onError,
  });
}
