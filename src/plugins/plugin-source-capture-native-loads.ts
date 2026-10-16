import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
} from "../infra/sqlite-staging-token.js";

export type NativeCaptureMaintenance = {
  retainedPaths: ReadonlySet<string>;
  assertCurrent: () => void | Promise<void>;
  removed: string[];
  startup?: boolean;
};
/** The process-wide capture owner installs this observer once. */
function observePluginNativeLoads(): ReadonlySet<string> {
  const paths = new Set<string>();
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
      paths.add(process.platform === "win32" ? normalizeWindowsPathPreservingCase(file) : file);
    } catch {
      // Observation must not replace the native loader's return or original error.
    }
    return loadAddon(...args);
  };
  return paths;
}

export function createPluginNativeCaptureCustody(ownedRoots: Set<string>) {
  const nativeLoadPaths = observePluginNativeLoads();
  const nativeReferences = new Map<string, number>();
  const retiringNativeRoots = new Set<string>();
  const retainedRoots = new Set<string>();
  /** Reclamation owns an existing native token until its captured payload is gone. */
  async function reclaimInstance(
    directory: string,
    originalDirectory: fs.Stats,
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

  return {
    reclaimInstance,
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
