import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { withProfile } from "./plugin-load-profile.js";
export function createPluginSourceLoader() {
    const loaders = new Map();
    return (modulePath) => {
        const jiti = getCachedPluginJitiLoader({
            cache: loaders,
            modulePath,
            importerUrl: import.meta.url,
            jitiFilename: import.meta.url,
        });
        // Direct source loads are not associated with a specific plugin id —
        // preserve the existing `plugin=(direct)` field used by tooling that
        // scrapes [plugin-load-profile] lines.
        return withProfile({ pluginId: "(direct)", source: modulePath }, "source-loader", () => jiti(modulePath));
    };
}
