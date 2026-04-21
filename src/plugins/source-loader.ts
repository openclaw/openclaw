import type { PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { profilePluginLoaderSync } from "./plugin-load-profile.js";

export type PluginSourceLoader = (modulePath: string) => unknown;

export function createPluginSourceLoader(): PluginSourceLoader {
  const loaders: PluginJitiLoaderCache = new Map();
  return (modulePath) => {
    const jiti = getCachedPluginJitiLoader({
      cache: loaders,
      modulePath,
      importerUrl: import.meta.url,
      jitiFilename: import.meta.url,
    });
    return profilePluginLoaderSync({
      // Direct source loads are not associated with a specific plugin id —
      // preserve the existing `plugin=(direct)` field used by tooling that
      // scrapes [plugin-load-profile] lines.
      phase: "source-loader",
      pluginId: "(direct)",
      source: modulePath,
      run: () => jiti(modulePath),
    });
  };
}
