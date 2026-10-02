import fs from "node:fs";
import path from "node:path";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";

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

export function createPluginNativeCaptureCustody(ownedRoots: ReadonlySet<string>) {
  const nativeLoadPaths = observePluginNativeLoads();
  const nativeReferences = new Map<string, number>();
  const retiringNativeRoots = new Set<string>();
  const retainedRoots = new Set<string>();
  return {
    nativeReferences,
    retiringNativeRoots,
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
