/** Gateway lifetime binding over the admitted plugin registry, not a second source owner. */
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { RepositorySources } from "../plugins/repository-source-types.js";
import { resolvePluginRepositorySource } from "../plugins/repository-sources.js";

export function createRepositorySources(
  signal: AbortSignal,
  registry?: PluginRegistry,
): RepositorySources {
  return {
    resolve(url: string, sourceId?: string) {
      signal.throwIfAborted();
      return resolvePluginRepositorySource(sourceId, url, registry, () => signal.throwIfAborted());
    },
  };
}
export type { RepositorySources } from "../plugins/repository-source-types.js";
