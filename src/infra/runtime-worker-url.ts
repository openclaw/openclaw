import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRootJsonObjectSync } from "@openclaw/fs-safe/json";
import { isBunRuntime } from "../daemon/runtime-binary.js";

/** Resolve an explicit installed root, source sibling, or stable packaged worker path. */
export function resolveRuntimeWorkerUrl(params: {
  currentModuleUrl: string;
  sourceWorkerName: string;
  distWorkerPath: string;
  root?: string;
  /** Package-local output when the nearest dist belongs to this package. */
  package?: { name: string; distWorkerPath: string };
}): URL {
  if (params.root !== undefined) {
    return pathToFileURL(path.join(params.root, "dist", params.distWorkerPath));
  }
  const currentPath = fileURLToPath(params.currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    let workerPath = params.distWorkerPath;
    if (params.package) {
      const packageRoot = path.resolve(distRoot, "..");
      const manifest = readRootJsonObjectSync({
        rootDir: packageRoot,
        relativePath: "package.json",
        boundaryLabel: "runtime worker package",
        rejectHardlinks: false,
      });
      if (!manifest.ok) {
        throw new Error(`Cannot resolve runtime worker package: ${packageRoot}/package.json`);
      }
      // Standalone plugins keep their own dist root, including shared build chunks.
      if (manifest.value.name === params.package.name) {
        workerPath = params.package.distWorkerPath;
      }
    }
    return pathToFileURL(path.join(distRoot, workerPath));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./${params.sourceWorkerName}${extension}`, params.currentModuleUrl);
}

export function resolveRuntimeWorkerArgv(url: URL, execPath = process.execPath): string[] {
  const entry = fileURLToPath(url);
  // Resolve the preload here: Node resolves bare imports from the child cwd.
  return /\.[cm]?ts$/.test(entry) && !isBunRuntime(execPath)
    ? ["--import", import.meta.resolve("tsx"), entry]
    : [entry];
}
