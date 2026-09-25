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
  // Source workers may run in isolated workspaces without node_modules. Resolve
  // the trusted loader from this installation, never from the worker's cwd.
  // For ESM workers, do not install tsx's CJS hook: it rewrites compiled plugin
  // imports to require(), breaking dependencies with import-only exports.
  if (!/\.[cm]?ts$/.test(entry) || isBunRuntime(execPath)) {
    return [entry];
  }
  if (entry.endsWith(".cts")) {
    return ["--import", import.meta.resolve("tsx"), entry];
  }
  // Pin aliases to the trusted source installation, not a task-controlled cwd
  // or tsconfig. ESM-only registration preserves import-only plugin dependencies.
  const registration = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)))} });`;
  return [
    "--import",
    `data:text/javascript;base64,${Buffer.from(registration).toString("base64")}`,
    entry,
  ];
}

/** Select the source Worker preload without feeding Node's TypeScript loader to Bun. */
export function resolveRuntimeWorkerThreadExecArgv(
  url: URL,
  execPath = process.execPath,
): string[] {
  if (url.protocol !== "file:") {
    return [];
  }
  return /\.[cm]?ts$/.test(fileURLToPath(url)) && !isBunRuntime(execPath)
    ? ["--import", import.meta.resolve("tsx/esm")]
    : [];
}
