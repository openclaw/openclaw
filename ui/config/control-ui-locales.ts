import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport, type Alias, type Plugin } from "vite";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
  setControlUiCatalogValue,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { flattenTranslations } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { TranslationMap } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const localeModulePrefix = "virtual:openclaw-control-ui-locale/";
const localeConfigHintsModulePrefix = "virtual:openclaw-control-ui-locale-config-hints/";
const localeNamespaceModulePrefix = "virtual:openclaw-control-ui-locale-namespace/";
const resolvedLocaleModulePrefix = `\0${localeModulePrefix}`;
export const resolvedLocaleConfigHintsModulePrefix = `\0${localeConfigHintsModulePrefix}`;
export const resolvedLocaleNamespaceModulePrefix = `\0${localeNamespaceModulePrefix}`;
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
  startupKeys: Set<string>;
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
    startupKeys: new Set(flattenTranslations(module.loadControlUiStartupCatalog()).keys()),
    // Vite reports transitive files separately from the entry that also needs watching.
    watchFiles: new Set([sourceCatalogPath, ...dependencies]),
  };
}

type ControlUiLocaleCatalogPartition = {
  base: TranslationMap;
  configHints: TranslationMap;
  namespaces: Record<string, TranslationMap>;
};

function partitionControlUiLocaleCatalog(
  catalog: TranslationMap,
  startupKeys: ReadonlySet<string>,
): ControlUiLocaleCatalogPartition {
  const partition: ControlUiLocaleCatalogPartition = { base: {}, configHints: {}, namespaces: {} };
  for (const [key, text] of flattenTranslations(catalog)) {
    const namespace = key.split(".", 1)[0]!;
    const target =
      namespace === "configHints"
        ? partition.configHints
        : startupKeys.has(key)
          ? partition.base
          : (partition.namespaces[namespace] ??= {});
    setControlUiCatalogValue(target, key, text);
  }
  return partition;
}

async function loadControlUiLocaleCatalogPartition(
  locale: string,
  sourceCatalog: TranslationMap,
  startupKeys: ReadonlySet<string>,
  memoryPath: string,
): Promise<ControlUiLocaleCatalogPartition> {
  // Source PRs omit generated memory until the post-merge refresh runs.
  // Existing empty or malformed memory stays fatal below so drift cannot hide.
  if (!existsSync(memoryPath)) {
    return partitionControlUiLocaleCatalog(sourceCatalog, startupKeys);
  }
  const memory = loadControlUiTranslationMemory(memoryPath);
  if (memory.size === 0) {
    throw new Error(`Control UI ${locale} translation memory is missing or empty`);
  }
  return partitionControlUiLocaleCatalog(
    materializeControlUiLocaleCatalog(flattenTranslations(sourceCatalog), memory),
    startupKeys,
  );
}

function parseResolvedLocaleModuleId(id: string): { locale: string; namespace?: string } | null {
  if (id.startsWith(resolvedLocaleNamespaceModulePrefix)) {
    const [locale, namespace, extra] = id
      .slice(resolvedLocaleNamespaceModulePrefix.length)
      .split("/");
    return locale && locales.has(locale) && namespace && /^[\w]+$/.test(namespace) && !extra
      ? { locale, namespace }
      : null;
  }
  const configHints = id.startsWith(resolvedLocaleConfigHintsModulePrefix);
  const prefix = configHints ? resolvedLocaleConfigHintsModulePrefix : resolvedLocaleModulePrefix;
  if (!id.startsWith(prefix)) {
    return null;
  }
  const locale = id.slice(prefix.length);
  return locales.has(locale)
    ? { locale, namespace: configHints ? "configHints" : undefined }
    : null;
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
      if (parseResolvedLocaleModuleId(`\0${id}`)) {
        return `\0${id}`;
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
        // Vite turns watched files into imports during dev transforms. A source-only
        // locale has no memory file yet, so importing that path would fail.
        if (existsSync(memoryPath)) {
          this.addWatchFile(memoryPath);
        }
        let partitionLoad = activeCache.partitionLoads.get(request.locale);
        if (!partitionLoad) {
          partitionLoad = loadControlUiLocaleCatalogPartition(
            request.locale,
            sourceCatalogResult.catalog,
            sourceCatalogResult.startupKeys,
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
        if (request.namespace === "configHints") {
          return `export default ${JSON.stringify(partition.configHints)};`;
        }
        if (request.namespace) {
          return `export default ${JSON.stringify(partition.namespaces[request.namespace] ?? {})};`;
        }
        const loaders = [
          ["configHints", `${localeConfigHintsModulePrefix}${request.locale}`],
          ...Object.keys(partition.namespaces).map((namespace) => [
            namespace,
            `${localeNamespaceModulePrefix}${request.locale}/${namespace}`,
          ]),
        ].map(
          ([namespace, specifier]) =>
            `${JSON.stringify(namespace)}: () => import(${JSON.stringify(specifier)})`,
        );
        return `import { createLazyLocaleCatalog } from ${JSON.stringify(path.join(repoRoot, "ui/src/i18n/lib/lazy-catalog.ts"))};
export default createLazyLocaleCatalog(${JSON.stringify(partition.base)}, {${loaders.join(",")}});`;
      }
    },
  };
}
