import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  createSealedRuntimeProcessEntrypoints,
  runtimeProcessDeployEntryFileName,
  runtimeProcessExternalPackageEntrypoints,
  runtimeProcessScriptEntrypoints,
  type runtimeProcessDeployManifest,
  type runtimeProcessSealedManifest,
} from "./runtime-process-manifest.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

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
