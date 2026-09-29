import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { asFsSafeFileLockRoot, createFileLockManager } from "./file-lock-manager.js";
import { root } from "./fs-safe.js";

const PACKAGE_LIFECYCLE_LOCK_RELATIVE_PATH = ".openclaw-lifecycle-lock";
const DEFAULT_PACKAGE_LIFECYCLE_SCRIPT_TIMEOUT_MS = 20 * 60_000;
const PACKAGE_LIFECYCLE_LOCK_POLL_MS = 100;
const PACKAGE_LIFECYCLE_LOCK_WAIT_GRACE_MS = 20 * 60_000;
const lifecycleLocks = createFileLockManager("openclaw.package-lifecycle");

/** Ownership is uncertain: callers must preserve the package until its writers settle. */
export class PackageLifecycleOwnershipError extends Error {
  readonly packageRoot: string;
  readonly lockPath: string;

  constructor(packageRoot: string, reason: string, cause?: unknown) {
    const lockPath = path.join(packageRoot, PACKAGE_LIFECYCLE_LOCK_RELATIVE_PATH);
    super(
      `OpenClaw package lifecycle ownership is uncertain (${reason}). Preserved package: ${packageRoot}. ` +
        `Wait for its lifecycle writers to settle before retrying or recovering ${lockPath}; lock age or a dead parent alone does not establish settlement.`,
      { cause },
    );
    this.name = "PackageLifecycleOwnershipError";
    this.packageRoot = packageRoot;
    this.lockPath = lockPath;
  }
}

type LifecycleLockOwner = { pid: number; starttime: number };

function parseLifecycleLockOwner(raw: string): LifecycleLockOwner | null {
  try {
    const owner = asNullableRecord(JSON.parse(raw));
    return owner?.kind === "openclaw-package-lifecycle" &&
      owner.version === 1 &&
      typeof owner.pid === "number" &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.starttime === "number" &&
      Number.isFinite(owner.starttime) &&
      owner.starttime >= 0
      ? { pid: owner.pid, starttime: owner.starttime }
      : null;
  } catch {
    return null;
  }
}

export type PackageLifecycleScript = Readonly<{
  name: "preinstall" | "postinstall";
  relativePath: string;
}>;

const PACKAGE_LIFECYCLE_SCRIPTS: readonly PackageLifecycleScript[] = [
  {
    name: "preinstall",
    relativePath: path.join("scripts", "preinstall-package-manager-warning.mjs"),
  },
  {
    name: "postinstall",
    relativePath: path.join("scripts", "postinstall-bundled-plugins.mjs"),
  },
];
function resolveLifecycleBudgetMs(scriptTimeoutMs: number): number {
  return scriptTimeoutMs * PACKAGE_LIFECYCLE_SCRIPTS.length;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function resolveLifecyclePaths(packageRoot: string) {
  return {
    packageRoot,
    pending: path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
    legacyGuard: path.join(packageRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
    lock: path.join(packageRoot, PACKAGE_LIFECYCLE_LOCK_RELATIVE_PATH),
  };
}

type LifecycleRoot = ReturnType<typeof asFsSafeFileLockRoot>;

async function bindLifecycleRoot(packageRoot: string): Promise<LifecycleRoot | undefined> {
  try {
    return asFsSafeFileLockRoot(await root(packageRoot));
  } catch (error) {
    if (hasErrorCode(error, "not-found")) {
      return undefined;
    }
    throw new PackageLifecycleOwnershipError(packageRoot, "package root cannot be bound", error);
  }
}

async function assertLifecycleRoot(packageRoot: string, packageDirectory: LifecycleRoot) {
  try {
    await packageDirectory.resolve(".");
  } catch (error) {
    throw new PackageLifecycleOwnershipError(packageRoot, "package root cannot be verified", error);
  }
}

async function isPackageLifecyclePending(
  paths: ReturnType<typeof resolveLifecyclePaths>,
  packageDirectory: LifecycleRoot,
) {
  await assertLifecycleRoot(paths.packageRoot, packageDirectory);
  const pending = (await pathExists(paths.pending)) || (await pathExists(paths.legacyGuard));
  await assertLifecycleRoot(paths.packageRoot, packageDirectory);
  return pending;
}

async function assertLifecycleAuthority(
  paths: ReturnType<typeof resolveLifecyclePaths>,
  packageDirectory: LifecycleRoot,
  lock: Awaited<ReturnType<typeof acquireLifecycleLock>>,
): Promise<void> {
  await assertLifecycleRoot(paths.packageRoot, packageDirectory);
  await assertLifecycleLockOwnership(paths.packageRoot, lock);
}

async function ensurePendingMarker(
  paths: ReturnType<typeof resolveLifecyclePaths>,
  packageDirectory: LifecycleRoot,
  lock: Awaited<ReturnType<typeof acquireLifecycleLock>>,
): Promise<void> {
  await assertLifecycleAuthority(paths, packageDirectory, lock);
  try {
    await fs.writeFile(paths.pending, "pending\n", { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
}

async function acquireLifecycleLock(
  paths: ReturnType<typeof resolveLifecyclePaths>,
  scriptTimeoutMs: number,
  waitForOwner = true,
  lockRoot?: LifecycleRoot,
) {
  // Preserve the shipped admission envelope without timing or expiring healthy script work.
  const waitBudgetMs =
    resolveLifecycleBudgetMs(scriptTimeoutMs) + PACKAGE_LIFECYCLE_LOCK_WAIT_GRACE_MS;
  if (!Number.isFinite(scriptTimeoutMs) || scriptTimeoutMs < 0 || !Number.isFinite(waitBudgetMs)) {
    throw new RangeError("Package lifecycle script timeout must be finite and non-negative");
  }
  const waitDeadline = performance.now() + waitBudgetMs;
  while (true) {
    if (performance.now() >= waitDeadline) {
      throw new PackageLifecycleOwnershipError(paths.packageRoot, "admission wait expired");
    }
    const observation: { owner: LifecycleLockOwner | null } = { owner: null };
    try {
      return await lifecycleLocks.acquire(paths.lock, {
        lockPath: paths.lock,
        ...(lockRoot ? { lockRoot } : {}),
        staleMs: 0,
        retry: { retries: 0 },
        staleRecovery: "fail-closed",
        shouldReclaim: () => false,
        // A parent can exit while a script still writes. Never release implicitly on exit.
        retainOnExit: true,
        payload: () => ({
          kind: "openclaw-package-lifecycle",
          version: 1,
          pid: process.pid,
          starttime: getFileLockProcessStartTime(process.pid),
        }),
        parsePayload: (raw) => {
          observation.owner = parseLifecycleLockOwner(raw);
          return observation.owner;
        },
      });
    } catch (error) {
      if (!hasErrorCode(error, "file_lock_timeout")) {
        if (lockRoot) {
          await assertLifecycleRoot(paths.packageRoot, lockRoot);
        }
        // The provider preserves operational errors. Retain an observed or unreadable
        // lock, but keep ordinary creation failures removable when no lock exists
        // and the retained root, if any, is still valid.
        try {
          await fs.lstat(paths.lock);
        } catch (inspectionError) {
          if (hasErrorCode(inspectionError, "ENOENT")) {
            throw error;
          }
        }
        throw new PackageLifecycleOwnershipError(
          paths.packageRoot,
          "lock cannot be inspected",
          error,
        );
      }
      if (!waitForOwner) {
        throw new PackageLifecycleOwnershipError(
          paths.packageRoot,
          "lifecycle admission prevents stage disposal",
          error,
        );
      }
      const owner = observation.owner;
      // Identity permits waiting only. Dead, reused, partial and legacy records never
      // authorize takeover: neither this PID nor this callback owns all descendants.
      if (
        !owner ||
        !isPidAlive(owner.pid) ||
        getFileLockProcessStartTime(owner.pid) !== owner.starttime
      ) {
        try {
          await fs.lstat(paths.lock);
        } catch (inspectionError) {
          if (hasErrorCode(inspectionError, "ENOENT")) {
            // Release can precede even the provider's first payload read. Retry
            // exclusive creation, never reclamation, within the original deadline.
            continue;
          }
        }
        throw new PackageLifecycleOwnershipError(
          paths.packageRoot,
          "owner cannot be verified",
          error,
        );
      }
      const remainingMs = waitDeadline - performance.now();
      if (remainingMs <= 0) {
        throw new PackageLifecycleOwnershipError(
          paths.packageRoot,
          "admission wait expired",
          error,
        );
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(PACKAGE_LIFECYCLE_LOCK_POLL_MS, remainingMs));
      });
    }
  }
}

function runPackageLifecycleScript(
  packageRoot: string,
  script: PackageLifecycleScript,
  timeoutMs: number,
): void {
  const scriptPath = path.join(packageRoot, script.relativePath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
    timeout: timeoutMs,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `OpenClaw package ${script.name} failed${result.signal ? ` with ${result.signal}` : ` with exit code ${result.status ?? "unknown"}`}`,
    );
  }
}

async function assertLifecycleLockOwnership(
  packageRoot: string,
  lock: Awaited<ReturnType<typeof acquireLifecycleLock>>,
): Promise<void> {
  try {
    if (await lock.verifyStillHeld()) {
      return;
    }
  } catch (error) {
    throw new PackageLifecycleOwnershipError(packageRoot, "ownership check failed", error);
  }
  throw new PackageLifecycleOwnershipError(packageRoot, "lock generation changed");
}

/** Retire discarded private candidates without dispatching their pending scripts. */
export async function discardPendingPackageLifecycle(params: {
  packageRoots: readonly string[];
  discard: () => Promise<void>;
}): Promise<void> {
  const owned: Array<{
    paths: ReturnType<typeof resolveLifecyclePaths>;
    packageDirectory: LifecycleRoot;
    lock: Awaited<ReturnType<typeof acquireLifecycleLock>>;
    retiredWork: boolean;
  }> = [];
  let failure: { error: unknown } | undefined;
  try {
    // An isolated pnpm stage can contain several install directories, including
    // an unlinked failed replacement. Admit every removed package before mutation.
    for (const packageRoot of params.packageRoots) {
      const paths = resolveLifecyclePaths(path.resolve(packageRoot));
      const packageDirectory = await bindLifecycleRoot(paths.packageRoot);
      if (!packageDirectory) {
        continue;
      }
      const lock = await acquireLifecycleLock(
        paths,
        DEFAULT_PACKAGE_LIFECYCLE_SCRIPT_TIMEOUT_MS,
        false,
      );
      owned.push({ paths, packageDirectory, lock, retiredWork: false });
    }
    // Recursive removal can unlink a lock before the scripts. Retire both markers
    // while held, so even a waiting completer dispatches nothing during removal.
    for (const entry of owned) {
      for (const marker of [entry.paths.pending, entry.paths.legacyGuard]) {
        await assertLifecycleAuthority(entry.paths, entry.packageDirectory, entry.lock);
        if (await pathExists(marker)) {
          await assertLifecycleAuthority(entry.paths, entry.packageDirectory, entry.lock);
          await fs.rm(marker, { force: true });
          entry.retiredWork = true;
        }
      }
    }
    for (const { paths, packageDirectory, lock } of owned) {
      await assertLifecycleAuthority(paths, packageDirectory, lock);
    }
    await params.discard();
  } catch (error) {
    failure = { error };
    for (const entry of owned) {
      try {
        // A removal error is ordinary only while the original authority remains.
        await assertLifecycleAuthority(entry.paths, entry.packageDirectory, entry.lock);
        if (entry.retiredWork) {
          await ensurePendingMarker(entry.paths, entry.packageDirectory, entry.lock);
        }
      } catch (recoveryError) {
        failure = {
          error:
            recoveryError instanceof PackageLifecycleOwnershipError
              ? recoveryError
              : new PackageLifecycleOwnershipError(
                  entry.paths.packageRoot,
                  "discarded work cannot be recovered",
                  recoveryError,
                ),
        };
      }
    }
  }
  for (const { paths, lock } of owned.toReversed()) {
    try {
      // Successful disposal removed this path. Matching release tolerates that.
      await lock.release();
    } catch (error) {
      failure = {
        error: new PackageLifecycleOwnershipError(paths.packageRoot, "lock release failed", error),
      };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

export async function completePendingPackageLifecycle(params: {
  packageRoot: string;
  runScript?: (script: PackageLifecycleScript) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<boolean> {
  const packageRoot = path.resolve(params.packageRoot);
  const scriptTimeoutMs = params.timeoutMs ?? DEFAULT_PACKAGE_LIFECYCLE_SCRIPT_TIMEOUT_MS;
  const paths = resolveLifecyclePaths(packageRoot);
  // Bind before observing work, and retain that directory across every retry.
  const packageDirectory = await bindLifecycleRoot(packageRoot);
  if (!packageDirectory) {
    return false;
  }
  if (!(await isPackageLifecyclePending(paths, packageDirectory))) {
    try {
      // Postinstall can clear its marker before its invocation settles. A lock
      // still requires admission before callers may verify or activate this package.
      await fs.lstat(paths.lock);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        await assertLifecycleRoot(packageRoot, packageDirectory);
        return false;
      }
      throw new PackageLifecycleOwnershipError(packageRoot, "lock cannot be inspected", error);
    }
  }

  const lock = await acquireLifecycleLock(paths, scriptTimeoutMs, true, packageDirectory);
  const assertOwnership = () => assertLifecycleAuthority(paths, packageDirectory, lock);
  let observedPendingWork = false;
  const completeWhileHeld = async () => {
    observedPendingWork = await isPackageLifecyclePending(paths, packageDirectory);
    if (!observedPendingWork) {
      await assertOwnership();
      return false;
    }
    const finalizeLegacyMarker = !(await pathExists(
      path.join(packageRoot, PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH),
    ));
    await assertOwnership();
    // Promote the shipped 2026.8.1 dist guard before preinstall removes it.
    // Modern postinstall clears the canonical marker after all lifecycle work succeeds.
    await ensurePendingMarker(paths, packageDirectory, lock);
    const runScript =
      params.runScript ??
      ((script) => runPackageLifecycleScript(packageRoot, script, scriptTimeoutMs));
    for (const script of PACKAGE_LIFECYCLE_SCRIPTS) {
      await assertOwnership();
      await runScript(script);
    }
    await assertOwnership();
    if (finalizeLegacyMarker) {
      // Legacy postinstall cannot clear this marker. Package capability survives
      // interrupted promotion, so successful retries can still finalize it.
      await fs.rm(paths.pending, { force: true });
    }
    if (await isPackageLifecyclePending(paths, packageDirectory)) {
      throw new Error("OpenClaw package postinstall did not complete its lifecycle marker");
    }
    return true;
  };
  let outcome: { completed: boolean } | { error: unknown };
  try {
    outcome = { completed: await completeWhileHeld() };
  } catch (error) {
    outcome = { error };
  }
  try {
    // A failed script is safely removable only while this generation still owns it.
    await assertOwnership();
  } catch (error) {
    outcome = { error };
  }
  // A no-work caller must not recreate markers retired before its admission.
  if ("error" in outcome && observedPendingWork) {
    try {
      await ensurePendingMarker(paths, packageDirectory, lock);
    } catch (error) {
      if (error instanceof PackageLifecycleOwnershipError) {
        outcome = { error };
      } else {
        // A marker write failure does not make settled work uncertain while
        // this invocation still owns the same directory and lock generation.
        try {
          await assertOwnership();
        } catch (ownershipError) {
          outcome = { error: ownershipError };
        }
      }
    }
  }
  try {
    await lock.release();
  } catch (error) {
    if (observedPendingWork) {
      await ensurePendingMarker(paths, packageDirectory, lock).catch(() => undefined);
    }
    // Uncertain release must preserve the stage even if the script itself failed.
    throw new PackageLifecycleOwnershipError(packageRoot, "lock release failed", error);
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.completed;
}
