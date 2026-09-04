import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

type RuntimeProcessEntrypointName = keyof typeof runtimeProcessEntrypoints;

const sealedEntrypoints = new Map<RuntimeProcessEntrypointName, URL>();

// Keep catalog imports out of the generic resolver so sealed handoff staging
// does not demand a general worker build. Deploy bundles register their sibling
// before launch because their paths have no /dist/ marker.
export function registerSealedRuntimeProcessEntrypoint(
  name: RuntimeProcessEntrypointName,
  url: URL,
): void {
  sealedEntrypoints.set(name, url);
}

export function resolveRuntimeProcessEntrypointUrl(name: RuntimeProcessEntrypointName): URL {
  return sealedEntrypoints.get(name) ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints[name]);
}
