import { createJiti } from "jiti";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";

export type PluginSourceLoader = (modulePath: string) => unknown;

function shouldProfilePluginSourceLoader(): boolean {
  return process.env.OPENCLAW_PLUGIN_LOAD_PROFILE === "1";
}

export function createPluginSourceLoader(): PluginSourceLoader {
  const loaders = new Map<string, ReturnType<typeof createJiti>>();
  return (modulePath) => {
    const tryNative = shouldPreferNativeJiti(modulePath);
    const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
    const cacheKey = JSON.stringify({
      tryNative,
      aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
    });
    let jiti = loaders.get(cacheKey);
    if (!jiti) {
      jiti = createJiti(import.meta.url, {
        ...buildPluginLoaderJitiOptions(aliasMap),
        tryNative,
      });
      loaders.set(cacheKey, jiti);
    }
    if (!shouldProfilePluginSourceLoader()) {
      return jiti(modulePath);
    }
    const startMs = performance.now();
    try {
      return jiti(modulePath);
    } finally {
      console.error(
        `[plugin-load-profile] phase=source-loader plugin=(direct) elapsedMs=${(performance.now() - startMs).toFixed(1)} source=${modulePath}`,
      );
    }
  };
}
