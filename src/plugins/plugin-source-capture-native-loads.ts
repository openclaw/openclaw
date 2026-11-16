import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  FsSafeCopyReply,
  FsSafeCopyWrite,
  PluginCaptureReclaimCandidate,
} from "../infra/fs-safe-copy-worker-contract.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
} from "../infra/sqlite-staging-token.js";

export async function reclaimLegacyPluginCapture(candidate: PluginCaptureReclaimCandidate) {
  const current = fs.lstatSync(candidate.directory);
  if (
    current.isDirectory() &&
    current.dev === candidate.identity.dev &&
    current.ino === candidate.identity.ino &&
    current.uid === candidate.identity.uid &&
    (!process.getuid || current.uid === process.getuid())
  ) {
    // Legacy producers surviving the grace period remain best effort.
    await fsPromises.rm(candidate.directory, { recursive: true, force: true });
  }
}

/** Standalone process only: creator connections remain in the Gateway. */
export async function reclaimPluginCaptureBatch(
  candidates: readonly PluginCaptureReclaimCandidate[],
) {
  const custody = createPluginNativeCaptureCustody(new Set());
  let failures = 0;
  let firstFailure: string | undefined;
  for (const candidate of candidates) {
    try {
      if (candidate.kind === "legacy") {
        await reclaimLegacyPluginCapture(candidate);
      } else {
        await custody.reclaimInstance(candidate.directory, candidate.identity);
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !isSqliteLockError(error)) {
        if (failures++ === 0) {
          firstFailure = formatErrorMessage(error);
        }
      }
    }
  }
  return { failures, firstFailure };
}

export type NativeCaptureMaintenance = {
  retainedPaths: ReadonlySet<string>;
  assertCurrent: () => void | Promise<void>;
  removed: string[];
  startup?: boolean;
};
/** The process-wide capture owner installs this observer once. */
const observedNativeLoadPaths = new Set<string>();
const nativeLoadObservers = new Set<(filename: string) => void>();

export function recordPluginNativeLoad(filename: string): void {
  observedNativeLoadPaths.add(
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(filename) : filename,
  );
}

export function subscribePluginNativeLoads(observer: (filename: string) => void): () => void {
  nativeLoadObservers.add(observer);
  return () => {
    nativeLoadObservers.delete(observer);
  };
}

function observePluginNativeLoads(): ReadonlySet<string> {
  const loadAddon = process.dlopen.bind(process);
  // Node keeps main-thread addons loaded: https://github.com/nodejs/node/blob/v24.8.0/src/env.cc#L1050
  // Windows mapped-image unlink fails (access denied becomes EPERM):
  // https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c#L1172
  // https://github.com/libuv/libuv/blob/v1.51.0/src/win/error.c#L158
  // Record before initialization: it can throw or reenter cleanup with the image already mapped.
  // Full diagnostic reports race Windows DbgHelp across workers; cleanup consumes load facts only.
  process.dlopen = (...args) => {
    try {
      const file = fs.realpathSync.native(args[1]);
      recordPluginNativeLoad(file);
      for (const observer of nativeLoadObservers) {
        observer(file);
      }
    } catch {
      // Observation must not replace the native loader's return or original error.
    }
    return loadAddon(...args);
  };
  return observedNativeLoadPaths;
}

export function createPluginNativeCaptureCustody(ownedRoots: Set<string>) {
  const nativeLoadPaths = observePluginNativeLoads();
  const nativeReferences = new Map<string, number>();
  const retiringNativeRoots = new Set<string>();
  const retainedRoots = new Set<string>();
  /** Reclamation owns an existing native token until its captured payload is gone. */
  async function reclaimInstance(
    directory: string,
    originalDirectory: Pick<fs.Stats, "dev" | "ino" | "uid">,
    nativeMaintenance?: NativeCaptureMaintenance,
  ): Promise<void> {
    const ownerPath = path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]);
    const family = SQLITE_STAGING_TOKEN_FILES.map((file) =>
      fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
    );
    const originalOwner = family[0];
    const captures = path.join(directory, "captures");
    const captured = fs.lstatSync(captures, { throwIfNoEntry: false });
    if (
      (process.getuid && originalDirectory.uid !== process.getuid()) ||
      !originalOwner ||
      family.some(
        (file) =>
          file &&
          (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid())),
      ) ||
      (captured && !captured.isDirectory())
    ) {
      return;
    }
    const unchanged = () => {
      const currentDirectory = fs.lstatSync(directory);
      const currentOwner = fs.lstatSync(ownerPath);
      return (
        currentDirectory.dev === originalDirectory.dev &&
        currentDirectory.ino === originalDirectory.ino &&
        currentDirectory.isDirectory() &&
        currentOwner.isFile() &&
        currentOwner.nlink === 1 &&
        currentOwner.dev === originalOwner.dev &&
        currentOwner.ino === originalOwner.ino
      );
    };
    // Reclaim refuses a missing token and never creates a replacement ownership database.
    const release = acquireSqliteStagingToken(directory, "reclaim");
    let released = false;
    const errors: unknown[] = [];
    ownedRoots.add(directory);
    try {
      if (!unchanged()) {
        return;
      }
      const native = path.join(directory, "native");
      // A producer can publish native bytes between inspection and exclusive admission.
      const nativeStat = fs.lstatSync(native, { throwIfNoEntry: false });
      await nativeMaintenance?.assertCurrent();
      if (!unchanged()) {
        return;
      }
      await fsPromises.rm(captures, { recursive: true, force: true });
      let retainedNative = Boolean(nativeStat);
      if (nativeStat?.isDirectory() && nativeMaintenance) {
        for (const nativeEntry of await fsPromises.readdir(native, { withFileTypes: true })) {
          const nativeDirectory = path.join(native, nativeEntry.name);
          if (!nativeEntry.isDirectory()) {
            continue;
          }
          await nativeMaintenance.assertCurrent();
          if (!unchanged()) {
            return;
          }
          const contained = (file: string) => file.startsWith(nativeDirectory + path.sep);
          if (
            [...nativeMaintenance.retainedPaths].some(contained) ||
            [...nativeReferences.keys()].some(contained)
          ) {
            continue;
          }
          retiringNativeRoots.add(nativeDirectory);
          try {
            await fsPromises.rm(nativeDirectory, { recursive: true, force: true });
            nativeMaintenance.removed.push(nativeDirectory);
          } finally {
            retiringNativeRoots.delete(nativeDirectory);
          }
        }
        retainedNative = (await fsPromises.readdir(native)).length > 0;
      }
      // Retirement closes staging admission; committed native readers use receipt-bound files.
      await nativeMaintenance?.assertCurrent();
      if (!unchanged()) {
        return;
      }
      release(true);
      released = true;
      // The shipped instance ID is never reused. Windows requires closing before unlink.
      if (!retainedNative) {
        await nativeMaintenance?.assertCurrent();
        if (unchanged()) {
          await fsPromises.rm(directory, { recursive: true, force: true });
        }
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (!released) {
          release();
        }
      } catch (error) {
        errors.push(error);
      } finally {
        ownedRoots.delete(directory);
      }
      throwSqliteLifecycleErrors(errors, "Plugin source reclamation and cleanup failed");
    }
  }

  /** Existing custody excludes new readers of bytes the child will delete. */
  function claimPluginCaptureReclaim(
    candidate: PluginCaptureReclaimCandidate,
  ): (() => void) | undefined {
    const { directory } = candidate;
    const deleted = candidate.kind === "managed" ? path.join(directory, "captures") : directory;
    if (
      ownedRoots.has(directory) ||
      [...nativeLoadPaths].some((file) => isPathInside(directory, file)) ||
      [...nativeReferences.keys()].some((file) => isPathInside(deleted, file))
    ) {
      return undefined;
    }
    ownedRoots.add(directory);
    retiringNativeRoots.add(deleted);
    return () => {
      retiringNativeRoots.delete(deleted);
      ownedRoots.delete(directory);
    };
  }

  /** The caller owns these retirement claims until the command owner confirms exit. */
  async function reclaimPluginCaptureSweep(
    candidates: readonly PluginCaptureReclaimCandidate[],
  ): Promise<{ failures: number; firstFailure?: string }> {
    if (candidates.length === 0) {
      return { failures: 0 };
    }
    const [
      { deserialize },
      { runtimeProcessEntrypoints },
      { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl },
      { runCommandBuffersWithTimeout },
      { hasCommandProcessCleanupError },
      { withCommandProcessScope },
      { withChildProcessOperation },
    ] = await Promise.all([
      import("node:v8"),
      import("../infra/runtime-process-entrypoints.js"),
      import("../infra/runtime-worker-url.js"),
      import("../process/exec-runner.js"),
      import("../process/exec-result.js"),
      import("../process/exec-spawn.js"),
      import("../process/spawn-diagnostics.js"),
    ]);
    const admitted: PluginCaptureReclaimCandidate[] = [];
    const releases: (() => void)[] = [];
    for (const candidate of candidates) {
      const release = claimPluginCaptureReclaim(candidate);
      if (release) {
        admitted.push(candidate);
        releases.push(release);
      }
    }
    if (admitted.length === 0) {
      return { failures: 0 };
    }
    let releaseClaims = true;
    try {
      const command: FsSafeCopyWrite = { type: "reclaim-plugin-captures", candidates: admitted };
      const result = await withCommandProcessScope(() =>
        withChildProcessOperation("plugin.capture-reclamation", () =>
          runCommandBuffersWithTimeout(
            [
              process.execPath,
              ...resolveRuntimeWorkerArgv(
                resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy),
              ),
            ],
            {
              input: JSON.stringify(command),
              beforeInput: () => {
                if (
                  admitted.some((candidate) =>
                    [...nativeLoadPaths].some((file) => isPathInside(candidate.directory, file)),
                  )
                ) {
                  throw new Error("Plugin capture became loaded before reclamation");
                }
              },
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              maxOutputBytes: 64 * 1024,
            },
          ),
        ),
      );
      if (result.code !== 0 || result.termination !== "exit") {
        throw new Error(`Plugin capture reclamation failed: ${result.termination}`);
      }
      // Its reply is consumed only after process exit and native cleanup join.
      // SAFETY: The bundled fs-safe worker serializes its typed FsSafeCopyReply.
      const reply = deserialize(result.stdout) as FsSafeCopyReply;
      if (reply.type === "failed") {
        throw new Error(reply.message);
      }
      if (reply.type !== "captures-reclaimed") {
        throw new Error("Plugin capture reclamation returned no completion receipt");
      }
      return reply;
    } catch (error) {
      releaseClaims = !hasCommandProcessCleanupError(error);
      throw error;
    } finally {
      if (releaseClaims) {
        for (const release of releases) {
          release();
        }
      }
    }
  }

  return {
    reclaimInstance,
    reclaimPluginCaptureSweep,
    /** Independent inventories and loaded modules can retain the same native namespace. */
    isPluginSourceCaptureRetained(this: void, directory: string): boolean {
      return (
        [...ownedRoots, ...retainedRoots].some(
          (root) => isPathInside(root, directory) || isPathInside(directory, root),
        ) ||
        [...nativeReferences.keys(), ...nativeLoadPaths].some((file) =>
          isPathInside(directory, file),
        )
      );
    },
    /** Physical module lifetime outlives registration and CommonJS cache eviction. */
    retainLoadedPluginSourceCapture(this: void, directory: string): boolean {
      if (![...nativeLoadPaths].some((file) => isPathInside(directory, file))) {
        return false;
      }
      const retained = [...ownedRoots].find((root) => isPathInside(root, directory)) ?? directory;
      if (
        ![...retainedRoots].some(
          (root) => isPathInside(root, retained) || isPathInside(retained, root),
        )
      ) {
        process.emitWarning(
          `Plugin source capture cleanup: retained-by-loaded-module: ${retained}; cleanup deferred until the next startup`,
        );
      }
      retainedRoots.add(retained);
      return true;
    },
    /** Warm generations retain superseded snapshots until their local cache retires. */
    retainPluginNativeCapturePath(this: void, capturedPath: string): () => void {
      const file = path.resolve(capturedPath);
      if ([...retiringNativeRoots].some((root) => file.startsWith(root + path.sep))) {
        throw new Error("Plugin native capture is being reclaimed");
      }
      nativeReferences.set(file, (nativeReferences.get(file) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const references = nativeReferences.get(file)!;
        if (references === 1) {
          nativeReferences.delete(file);
        } else {
          nativeReferences.set(file, references - 1);
        }
      };
    },
  };
}
