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
import {
  DEFAULT_LOCALE,
  LOCALE_MATCH_RULES,
  RTL_LOCALES,
  SUPPORTED_LOCALES,
} from "../../src/shared/control-ui-locale.ts";

const localeModulePrefix = "virtual:openclaw-control-ui-locale/";
const localeConfigHintsModulePrefix = "virtual:openclaw-control-ui-locale-config-hints/";
const localeNamespaceModulePrefix = "virtual:openclaw-control-ui-locale-namespace/";
const resolvedLocaleModulePrefix = `\0${localeModulePrefix}`;
export const resolvedLocaleConfigHintsModulePrefix = `\0${localeConfigHintsModulePrefix}`;
export const resolvedLocaleNamespaceModulePrefix = `\0${localeNamespaceModulePrefix}`;
export const controlUiLocaleErrorNamespaces: readonly string[] = [
  "runtimeErrors",
  "notificationErrors",
  "nativeDeviceEditError",
];
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

export function controlUiLocaleModulesPlugin(buildInputs?: Set<string>): Plugin {
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
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        // Direction cannot wait for the translated catalog: the critical frame paints first.
        const policy = JSON.stringify({
          supported: SUPPORTED_LOCALES,
          rules: LOCALE_MATCH_RULES,
          rtl: RTL_LOCALES,
          fallback: DEFAULT_LOCALE,
        }).replaceAll("<", "\\u003c");
        // These six late Chat namespaces leave at most one unhinted batch on a
        // six-connection origin. Keep per-locale hashes, not repeated asset URLs,
        // in the document paid for by English users too.
        const namespaces = [
          "chat",
          "attention",
          "profilePage",
          "mcpServers",
          "mcpPage",
          "sessionsView",
        ];
        const files = Object.values(context.bundle ?? {}).map((output) => output.fileName);
        const hashes: Record<string, string> = {};
        for (const locale of locales) {
          const prefixes = [
            locale,
            ...namespaces.map((name) => `locale-namespace-${locale}-${name}`),
          ];
          const row = prefixes.map((prefix) =>
            files
              .find((file) => file.startsWith(`assets/${prefix}-`) && file.endsWith(".js"))
              ?.slice(`assets/${prefix}-`.length, -3),
          );
          if (row.every(Boolean)) {
            hashes[locale] = row.join(" ");
          }
        }
        const helper = files.find((file) => /^assets\/lazy-catalog-[\w-]+\.js$/.test(file));
        const hints =
          helper && Object.keys(hashes).length
            ? `const base=document.documentElement.getAttribute("data-openclaw-control-ui-base-path")||"";if(locale!==p.fallback&&(location.pathname===base+"/chat"||location.pathname.startsWith(base+"/chat/"))){const hashes=(${JSON.stringify(hashes)})[locale];if(hashes){const names=${JSON.stringify(namespaces)};const files=hashes.split(" ").map((hash,i)=>"assets/"+(i?"locale-namespace-"+locale+"-"+names[i-1]:locale)+"-"+hash+".js");files.splice(1,0,${JSON.stringify(helper)});for(const file of files){const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="";link.href=base+"/"+file;document.head.append(link)}}}`
            : "";
        return [
          {
            tag: "script",
            attrs: { "data-cfasync": "false" },
            injectTo: "head-prepend",
            children: `(()=>{const p=${policy};let saved;try{saved=localStorage.getItem("openclaw.i18n.locale")}catch{}const language=(navigator.language||"").toLowerCase();const locale=p.supported.includes(saved)?saved:(p.rules.find(([pattern])=>new RegExp(pattern).test(language))?.[1]||p.fallback);document.documentElement.dir=p.rtl.includes(locale)?"rtl":"ltr";${hints}})();`,
          },
        ];
      },
    },
    configResolved(config) {
      sourceAliases = config.resolve.alias;
    },
    buildStart() {
      invalidateCatalogs();
    },
    watchChange() {
      invalidateCatalogs();
    },
    resolveId: {
      filter: { id: /^virtual:openclaw-control-ui-locale(?:-config-hints|-namespace)?\// },
      handler(id) {
        if (parseResolvedLocaleModuleId(`\0${id}`)) {
          return `\0${id}`;
        }
        return null;
      },
    },
    load: {
      filter: { id: /^\0virtual:openclaw-control-ui-locale(?:-config-hints|-namespace)?\// },
      async handler(id) {
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
            buildInputs?.add(watchFile);
          }
          // Vite turns watched files into imports during dev transforms. A source-only
          // locale has no memory file yet, so importing that path would fail.
          if (existsSync(memoryPath)) {
            this.addWatchFile(memoryPath);
            buildInputs?.add(memoryPath);
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
            const siblingErrors =
              request.namespace === "runtimeErrors"
                ? controlUiLocaleErrorNamespaces
                    .filter((namespace) => namespace !== "runtimeErrors")
                    .map(
                      (namespace) =>
                        `export const ${namespace} = ${JSON.stringify(partition.namespaces[namespace] ?? {})};`,
                    )
                    .join("\n")
                : "";
            return `export default ${JSON.stringify(partition.namespaces[request.namespace] ?? {})};\n${siblingErrors}`;
          }
          const shareErrorImport =
            "runtimeErrors" in partition.namespaces &&
            controlUiLocaleErrorNamespaces.some(
              (namespace) => namespace !== "runtimeErrors" && namespace in partition.namespaces,
            );
          const sharedErrorImport = shareErrorImport
            ? `import { getOrCreatePromise } from ${JSON.stringify(path.join(repoRoot, "src/shared/lazy-promise.ts"))};
const pendingErrors = new Map();
const loadRuntimeErrors = () => getOrCreatePromise(pendingErrors, "errors", () => import(${JSON.stringify(`${localeNamespaceModulePrefix}${request.locale}/runtimeErrors`)}), { evictOnSettled: true });`
            : "";
          const loaders = [
            ["configHints", `${localeConfigHintsModulePrefix}${request.locale}`],
            ...Object.keys(partition.namespaces).map((namespace) => [
              namespace,
              `${localeNamespaceModulePrefix}${request.locale}/${namespace}`,
            ]),
          ].map(([namespace, specifier]) => {
            const load = `import(${JSON.stringify(specifier)})`;
            if (shareErrorImport && controlUiLocaleErrorNamespaces.includes(namespace!)) {
              // Share the import itself: extra facade imports can wait behind boot work
              // even after the browser has finished downloading their shared asset.
              return `${JSON.stringify(namespace)}: ${namespace === "runtimeErrors" ? "loadRuntimeErrors" : `() => loadRuntimeErrors().then((catalog) => ({ default: catalog.${namespace} }))`}`;
            }
            return `${JSON.stringify(namespace)}: () => ${load}`;
          });
          return `import { createLazyLocaleCatalog } from ${JSON.stringify(path.join(repoRoot, "ui/src/i18n/lib/lazy-catalog.ts"))};
${sharedErrorImport}
export default createLazyLocaleCatalog(${JSON.stringify(partition.base)}, {${loaders.join(",")}});`;
        }
      },
    },
  };
}
