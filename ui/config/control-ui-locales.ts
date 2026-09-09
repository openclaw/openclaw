import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import type { Plugin } from "vite";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { flattenTranslations } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { TranslationMap } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

// Each locale is served as two virtual modules built from one materialized
// catalog: a base module without the dominant top-level configHints subtree and
// a fragment holding only { configHints }. The locale wrapper statically
// re-exports both, so one dynamic import loads both chunks and the registry
// shallow-merges the disjoint top-level maps back into the full catalog.
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
const sourceCatalogUrl = pathToFileURL(
  path.join(repoRoot, "scripts/lib/control-ui-i18n-catalog.ts"),
).href;

async function loadCurrentSourceCatalog(): Promise<{
  catalog: TranslationMap;
  watchFiles: Set<string>;
}> {
  const watchFiles = new Set<string>();
  const loader = register({
    namespace: `openclaw-control-ui-source-catalog-${randomUUID()}`,
    onImport(url) {
      if (url.startsWith("file:")) {
        watchFiles.add(fileURLToPath(url));
      }
    },
    tsconfig: path.join(repoRoot, "tsconfig.json"),
  });
  try {
    const module = (await loader.import(
      sourceCatalogUrl,
      import.meta.url,
    )) as typeof import("../../scripts/lib/control-ui-i18n-catalog.ts");
    return { catalog: module.loadControlUiSourceCatalog(), watchFiles };
  } finally {
    await loader.unregister();
  }
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
  // A base module and its fragment must be emitted from the same materialized
  // catalog so the split halves cannot drift apart within one build. The
  // caches are cleared before any watched source or memory file is re-read.
  let sourceCatalogLoad: ReturnType<typeof loadCurrentSourceCatalog> | null = null;
  const partitionLoads = new Map<string, Promise<ControlUiLocaleCatalogPartition>>();
  const invalidateCatalogs = () => {
    sourceCatalogLoad = null;
    partitionLoads.clear();
  };
  return {
    name: "control-ui-locale-modules",
    enforce: "pre",
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
      sourceCatalogLoad ??= loadCurrentSourceCatalog();
      const { catalog: sourceCatalog, watchFiles } = await sourceCatalogLoad;
      for (const watchFile of watchFiles) {
        this.addWatchFile(watchFile);
      }
      this.addWatchFile(memoryPath);
      let partitionLoad = partitionLoads.get(request.locale);
      if (!partitionLoad) {
        partitionLoad = loadControlUiLocaleCatalogPartition(
          request.locale,
          sourceCatalog,
          memoryPath,
        );
        partitionLoads.set(request.locale, partitionLoad);
      }
      const partition = await partitionLoad;
      return `export default ${JSON.stringify(request.configHints ? partition.configHints : partition.base)};`;
    },
  };
}
