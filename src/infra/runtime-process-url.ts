import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEmbeddedStandaloneModule, resolveStandaloneSidecarRoot } from "../../cli-invocation.mjs";
import { createRuntimeProcessScriptFile } from "../../runtime-process-scripts.generated.mjs";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  createSealedRuntimeProcessEntrypoints,
  runtimeProcessDeployEntryFileName,
  runtimeProcessExternalPackageEntrypoints,
  runtimeProcessScriptEntrypoints,
  type runtimeProcessDeployManifest,
  type runtimeProcessSealedManifest,
} from "./runtime-process-manifest.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

type RuntimeProcessEntrypointName = keyof typeof runtimeProcessEntrypoints;

type RuntimeScriptEntrypoints = typeof runtimeProcessScriptEntrypoints;
type RuntimeScriptFileEntrypointName = {
  [Name in keyof RuntimeScriptEntrypoints]: RuntimeScriptEntrypoints[Name] extends { kind: "file" }
    ? Name
    : never;
}[keyof RuntimeScriptEntrypoints];

const sealedEntrypoints = new Map<RuntimeProcessEntrypointName, URL>();

export function registerSealedRuntimeProcessEntrypoints(
  group: keyof typeof runtimeProcessSealedManifest,
  currentModuleUrl: string,
): void {
  createSealedRuntimeProcessEntrypoints(group, currentModuleUrl).forEach(({ name, url }) => {
    sealedEntrypoints.set(name, url);
  });
}

export function resolveExternalPackageRuntimeEntrypointUrl(
  name: keyof typeof runtimeProcessExternalPackageEntrypoints,
  packageRoot: string,
): URL {
  return pathToFileURL(path.join(packageRoot, runtimeProcessExternalPackageEntrypoints[name]));
}

export function resolveRuntimeProcessEntrypointUrl(name: RuntimeProcessEntrypointName): URL {
  return sealedEntrypoints.get(name) ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints[name]);
}

export function resolveRuntimeDeployEntrypointUrl(
  name: keyof typeof runtimeProcessDeployManifest,
  directory: string,
): URL {
  return pathToFileURL(path.join(directory, runtimeProcessDeployEntryFileName(name)));
}

export function resolveRuntimeScriptEntrypointUrl(
  name: RuntimeScriptFileEntrypointName,
  directory: string,
): URL {
  return pathToFileURL(path.join(directory, runtimeProcessScriptEntrypoints[name].fileName));
}

/** Standalone images use declared child entries; ordinary runtimes need a physical script. */
export function prepareRuntimeProcessScriptInvocation(
  name: Parameters<typeof createRuntimeProcessScriptFile>[0],
  execPath: string,
  options?: Parameters<typeof createRuntimeProcessScriptFile>[1],
): { argv: string[]; dispose(): void } {
  const entry = runtimeProcessScriptEntrypoints[name];
  if ("runtimeEntrypoint" in entry && execPath === process.execPath) {
    const url = resolveRuntimeProcessEntrypointUrl(entry.runtimeEntrypoint);
    if (isEmbeddedStandaloneModule(url.href)) {
      return { argv: [execPath, ...resolveRuntimeWorkerArgv(url, execPath)], dispose() {} };
    }
  }
  if ("runtimeEntrypoint" in entry) {
    const root = resolveStandaloneSidecarRoot(execPath);
    if (root !== undefined) {
      const child = runtimeProcessEntrypoints[entry.runtimeEntrypoint];
      return { argv: [execPath, path.join(root, "dist", child.distWorkerPath)], dispose() {} };
    }
  }
  const file = createRuntimeProcessScriptFile(name, options);
  return { argv: [execPath, fileURLToPath(file.url)], dispose: () => file.dispose() };
}
