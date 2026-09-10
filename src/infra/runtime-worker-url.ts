import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBunRuntime } from "../daemon/runtime-binary.js";

/** Resolve an explicit installed root, source sibling, or stable packaged worker path. */
export function resolveRuntimeWorkerUrl(params: {
  currentModuleUrl: string;
  sourceWorkerName: string;
  distWorkerPath: string;
  root?: string;
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
    return pathToFileURL(path.join(distRoot, params.distWorkerPath));
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
