import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport, type Alias, type Plugin } from "vite";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { flattenTranslations } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { TranslationMap } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const localeModulePrefix = "virtual:openclaw-control-ui-locale/";
const localeConfigHintsModulePrefix = "virtual:openclaw-control-ui-locale-config-hints/";
const resolvedLocaleModulePrefix = `\0${localeModulePrefix}`;
export const resolvedLocaleConfigHintsModulePrefix = `\0${localeConfigHintsModulePrefix}`;
// Vitest rewrites new URL(relative, import.meta.url) to browser self.location.
const i18nAssetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/.i18n",
);
const locales = new Set(CONTROL_UI_LOCALE_ENTRIES.map(({ locale }) => locale));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceCatalogPath = path.join(repoRoot, "scripts/lib/control-ui-i18n-catalog.ts");

async function loadCurrentSourceCatalog(aliases: Alias[]): Promise<{
  catalog: TranslationMap;
  watchFiles: Set<string>;
}> {
  // Each runner owns a fresh source graph without Node-only loader hooks.
  // Resolved aliases keep workspace sources in the graph, not installed package outputs.
  const { module, dependencies } = await runnerImport<
    typeof import("../../scripts/lib/control-ui-i18n-catalog.ts")
  >(sourceCatalogPath, {
    root: repoRoot,
    resolve: { alias: aliases },
  });
  return {
    catalog: module.loadControlUiSourceCatalog(),
    // Vite reports transitive files separately from the entry that also needs watching.
    watchFiles: new Set([sourceCatalogPath, ...dependencies]),
  };
}

type ControlUiLocaleCatalogPartition = {
  base: TranslationMap;
  configHints: TranslationMap;
};

function partitionControlUiLocaleCatalog(catalog: TranslationMap): ControlUiLocaleCatalogPartition {
  const { configHints, ...base } = catalog;
  return { base, configHints: configHints === undefined ? {} : { configHints } };
}

async function loadControlUiLocaleCatalogPartition(
  locale: string,
  sourceCatalog: TranslationMap,
  memoryPath: string,
): Promise<ControlUiLocaleCatalogPartition> {
  // Source PRs omit generated memory until the post-merge refresh runs.
  // Existing empty or malformed memory stays fatal below so drift cannot hide.
  if (!existsSync(memoryPath)) {
    return partitionControlUiLocaleCatalog(sourceCatalog);
  }
  const memory = loadControlUiTranslationMemory(memoryPath);
  if (memory.size === 0) {
    throw new Error(`Control UI ${locale} translation memory is missing or empty`);
  }
  return partitionControlUiLocaleCatalog(
    materializeControlUiLocaleCatalog(flattenTranslations(sourceCatalog), memory),
  );
}

function parseResolvedLocaleModuleId(id: string): { locale: string; configHints: boolean } | null {
  const configHints = id.startsWith(resolvedLocaleConfigHintsModulePrefix);
  const prefix = configHints ? resolvedLocaleConfigHintsModulePrefix : resolvedLocaleModulePrefix;
  if (!id.startsWith(prefix)) {
    return null;
  }
  const locale = id.slice(prefix.length);
  return locales.has(locale) ? { locale, configHints } : null;
}

export function controlUiLocaleModulesPlugin(): Plugin {
  let sourceAliases: Alias[] = [];
  // Both modules must share one materialization. Replacing the cache object
  // fences resolved and rejected work from an invalidated build generation.
  const createCatalogCache = () => ({
    sourceCatalogLoad: null as ReturnType<typeof loadCurrentSourceCatalog> | null,
    partitionLoads: new Map<string, Promise<ControlUiLocaleCatalogPartition>>(),
  });
  let catalogCache = createCatalogCache();
  const invalidateCatalogs = () => {
    catalogCache = createCatalogCache();
  };
  return {
    name: "control-ui-locale-modules",
    enforce: "pre",
    configResolved(config) {
      sourceAliases = config.resolve.alias;
    },
    buildStart() {
      invalidateCatalogs();
    },
    watchChange() {
      invalidateCatalogs();
    },
    resolveId(id) {
      for (const prefix of [localeModulePrefix, localeConfigHintsModulePrefix]) {
        if (id.startsWith(prefix) && locales.has(id.slice(prefix.length))) {
          return `\0${id}`;
        }
      }
      return null;
    },
    async load(id) {
      const request = parseResolvedLocaleModuleId(id);
      if (!request) {
        return null;
      }
      const memoryPath = path.join(i18nAssetsDir, `${request.locale}.tm.jsonl`);
      while (true) {
        const activeCache = catalogCache;
        activeCache.sourceCatalogLoad ??= loadCurrentSourceCatalog(sourceAliases).catch(
          (error: unknown) => {
            // A later request can retry a corrected source without a watched-file change.
            activeCache.sourceCatalogLoad = null;
            throw error;
          },
        );
        let sourceCatalogResult: Awaited<ReturnType<typeof loadCurrentSourceCatalog>>;
        try {
          sourceCatalogResult = await activeCache.sourceCatalogLoad;
        } catch (error) {
          if (activeCache !== catalogCache) {
            continue;
          }
          throw error;
        }
        if (activeCache !== catalogCache) {
          continue;
        }
        for (const watchFile of sourceCatalogResult.watchFiles) {
          this.addWatchFile(watchFile);
        }
        this.addWatchFile(memoryPath);
        let partitionLoad = activeCache.partitionLoads.get(request.locale);
        if (!partitionLoad) {
          partitionLoad = loadControlUiLocaleCatalogPartition(
            request.locale,
            sourceCatalogResult.catalog,
            memoryPath,
          );
          activeCache.partitionLoads.set(request.locale, partitionLoad);
        }
        let partition: ControlUiLocaleCatalogPartition;
        try {
          partition = await partitionLoad;
        } catch (error) {
          if (activeCache !== catalogCache) {
            continue;
          }
          throw error;
        }
        if (activeCache !== catalogCache) {
          continue;
        }
        if (request.configHints) {
          return `export default ${JSON.stringify(partition.configHints)};`;
        }
        return `import configHints from ${JSON.stringify(`${localeConfigHintsModulePrefix}${request.locale}`)};
export default { ...${JSON.stringify(partition.base)}, ...configHints };`;
      }
    },
  };
}
