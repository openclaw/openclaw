import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { registerSealedRuntimeWorkerUrl, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

type RuntimeProcessEntrypointName = keyof typeof runtimeProcessEntrypoints;

// Deploy bundles register their sibling before launch: their paths have no /dist/ marker.
export function registerSealedRuntimeProcessEntrypoint(
  name: RuntimeProcessEntrypointName,
  url: URL,
): void {
  registerSealedRuntimeWorkerUrl(runtimeProcessEntrypoints[name].distWorkerPath, url);
}

export function resolveRuntimeProcessEntrypointUrl(name: RuntimeProcessEntrypointName): URL {
  return resolveRuntimeWorkerUrl(runtimeProcessEntrypoints[name]);
}
