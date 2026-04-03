import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { loadConfig } from "../../config/config.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
  shouldPreferNativeJiti,
} from "../sdk-alias.js";

type PluginRuntimeRecord = {
  origin?: string;
  rootDir?: string;
  source: string;
};

type CachedPluginBoundaryLoaderParams = {
  pluginId: string;
  entryBaseName: string;
  required?: boolean;
  missingLabel?: string;
};

export function readPluginBoundaryConfigSafely() {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

export function resolvePluginRuntimeRecord(
  pluginId: string,
  onMissing?: () => never,
): PluginRuntimeRecord | null {
  const manifestRegistry = loadPluginManifestRegistry({
    config: readPluginBoundaryConfigSafely(),
    cache: true,
  });
  const record = manifestRegistry.plugins.find((plugin) => plugin.id === pluginId);
  if (!record?.source) {
    if (onMissing) {
      onMissing();
    }
    return null;
  }
  return {
    ...(record.origin ? { origin: record.origin } : {}),
    rootDir: record.rootDir,
    source: record.source,
  };
}

export function resolvePluginRuntimeModulePath(
  record: Pick<PluginRuntimeRecord, "rootDir" | "source">,
  entryBaseName: string,
  onMissing?: () => never,
): string | null {
  const candidates = [
    path.join(path.dirname(record.source), `${entryBaseName}.js`),
    path.join(path.dirname(record.source), `${entryBaseName}.ts`),
    ...(record.rootDir
      ? [
          path.join(record.rootDir, `${entryBaseName}.js`),
          path.join(record.rootDir, `${entryBaseName}.ts`),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  if (onMissing) {
    onMissing();
  }
  return null;
}

export function getPluginBoundaryJiti(
  modulePath: string,
  loaders: Map<boolean, ReturnType<typeof createJiti>>,
) {
  const tryNative = shouldPreferNativeJiti(modulePath);
  const cached = loaders.get(tryNative);
  if (cached) {
    return cached;
  }
  const pluginSdkAlias = resolvePluginSdkAliasFile({
    srcFile: "root-alias.cjs",
    distFile: "root-alias.cjs",
    modulePath,
  });
  const aliasMap = {
    ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
    ...resolvePluginSdkScopedAliasMap({ modulePath }),
  };
  const loader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  loaders.set(tryNative, loader);
  return loader;
}

export function loadPluginBoundaryModuleWithJiti<TModule>(
  modulePath: string,
  loaders: Map<boolean, ReturnType<typeof createJiti>>,
): TModule {
  return getPluginBoundaryJiti(modulePath, loaders)(modulePath) as TModule;
}

export function createCachedPluginBoundaryModuleLoader<TModule>(
  params: CachedPluginBoundaryLoaderParams,
): () => TModule | null {
  let cachedModulePath: string | null = null;
  let cachedModule: TModule | null = null;
  const loaders = new Map<boolean, ReturnType<typeof createJiti>>();

  return () => {
    const missingLabel = params.missingLabel ?? `${params.pluginId} plugin runtime`;
    const record = resolvePluginRuntimeRecord(
      params.pluginId,
      params.required
        ? () => {
            throw new Error(`${missingLabel} is unavailable: missing plugin '${params.pluginId}'`);
          }
        : undefined,
    );
    if (!record) {
      return null;
    }
    const modulePath = resolvePluginRuntimeModulePath(
      record,
      params.entryBaseName,
      params.required
        ? () => {
            throw new Error(
              `${missingLabel} is unavailable: missing ${params.entryBaseName} for plugin '${params.pluginId}'`,
            );
          }
        : undefined,
    );
    if (!modulePath) {
      return null;
    }
    if (cachedModule && cachedModulePath === modulePath) {
      return cachedModule;
    }
    const loaded = loadPluginBoundaryModuleWithJiti<TModule>(modulePath, loaders);
    cachedModulePath = modulePath;
    cachedModule = loaded;
    return loaded;
  };
}
