import fs from "node:fs";
import path from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { resolveGlobalMap } from "../shared/global-singleton.js";

type RetainedNativeEsmModule = {
  entry: string;
  sourceDigest?: string;
  modules: Map<string, unknown>;
  loaded: boolean;
};

const retainedNativeEsmModules = resolveGlobalMap<string, RetainedNativeEsmModule>(
  Symbol.for("openclaw.retainedNativeEsmPluginModules"),
  "plugin-registry",
);

/**
 * Native ESM is keyed by the installed entry and the workspace that loads it.
 * A captured copy gets a new file URL, and Node keeps that module job after
 * dispose deletes the directory. Two workspaces therefore keep two modules.
 * A load with no workspace uses the shared-root entry key.
 */
export function nativeEsmModuleIdentity(source: string, workspaceDir?: string): string | undefined {
  // Only the long-lived catalog worker reloads installed ESM on every generation.
  // Other isolates keep the per-generation capture used by explicit reloads.
  if (!isCatalogWorker()) {
    return undefined;
  }
  const extension = path.extname(source).toLowerCase();
  if (extension !== ".mjs" && (extension !== ".js" || !nearestPackageTypeIsModule(source))) {
    return undefined;
  }
  let installed: string;
  try {
    installed = fs.realpathSync(source);
  } catch {
    return undefined;
  }
  const workspace = workspaceDir?.trim();
  return workspace ? `${installed}\0${workspace}` : installed;
}

export function readRetainedNativeEsmModule(identity: string): RetainedNativeEsmModule | undefined {
  const retained = retainedNativeEsmModules.get(identity);
  return retained?.loaded ? retained : undefined;
}

/** Returns a module this worker already evaluated, and records the first evaluation of a new path. */
export function retainNativeEsmModuleLoad(
  identity: string,
  entry: string,
  sourceDigest: () => string | undefined,
  load: (source: string) => unknown,
): (source: string) => unknown {
  const resolvedEntry = fs.realpathSync(entry);
  return (source) => {
    const key = modulePathKey(source);
    let retained = retainedNativeEsmModules.get(identity);
    if (retained?.modules.has(key)) {
      return retained.modules.get(key);
    }
    const value = load(source);
    retained ??= {
      entry: resolvedEntry,
      modules: new Map(),
      loaded: false,
    };
    retained.modules.set(key, value);
    if (key === resolvedEntry) {
      retained.loaded = true;
      retained.sourceDigest = sourceDigest();
    }
    retainedNativeEsmModules.set(identity, retained);
    return value;
  };
}

function isCatalogWorker(): boolean {
  return (
    !isMainThread &&
    workerData !== null &&
    typeof workerData === "object" &&
    "sourceCaptureDirectory" in workerData
  );
}

function nearestPackageTypeIsModule(source: string): boolean {
  let directory = path.dirname(source);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
          return false;
        }
        return Object.getOwnPropertyDescriptor(parsed, "type")?.value === "module";
      } catch {
        return false;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}

function modulePathKey(source: string): string {
  try {
    return fs.realpathSync(source);
  } catch {
    return path.resolve(source);
  }
}
