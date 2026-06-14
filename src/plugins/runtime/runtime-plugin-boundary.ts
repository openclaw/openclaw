// Runtime plugin boundary helpers enforce package and source boundaries for runtime loading.
import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../../config/config.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import {
  isJavaScriptModulePath,
  tryNativeRequireJavaScriptModule,
} from "../native-module-require.js";
import {
  getCachedPluginSourceModuleLoader,
  type PluginModuleLoaderCache,
} from "../plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugin-origin.types.js";

type PluginRuntimeRecord = {
  origin?: PluginOrigin;
  rootDir?: string;
  source: string;
};

type ManifestRuntimePluginRecord = PluginRuntimeRecord & {
  id: string;
};

export function readPluginBoundaryConfigSafely() {
  try {
    return getRuntimeConfig();
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
  });
  for (const plugin of manifestRegistry.plugins) {
    const record = readManifestRuntimePluginRecord(plugin);
    if (record?.id === pluginId) {
      return toPluginRuntimeRecord(record);
    }
  }
  if (onMissing) {
    onMissing();
  }
  return null;
}

export function resolvePluginRuntimeRecordByEntryBaseNames(
  entryBaseNames: string[],
  onMissing?: () => never,
): PluginRuntimeRecord | null {
  const manifestRegistry = loadPluginManifestRegistry({
    config: readPluginBoundaryConfigSafely(),
  });
  const matches: ManifestRuntimePluginRecord[] = [];
  for (const plugin of manifestRegistry.plugins) {
    const record = readManifestRuntimePluginRecord(plugin);
    if (record && hasRuntimeEntryBaseNames(record, entryBaseNames)) {
      matches.push(record);
    }
  }
  if (matches.length === 0) {
    if (onMissing) {
      onMissing();
    }
    return null;
  }
  if (matches.length > 1) {
    const pluginIds = matches.map((plugin) => plugin.id).join(", ");
    throw new Error(
      `plugin runtime boundary is ambiguous for entries [${entryBaseNames.join(", ")}]: ${pluginIds}`,
    );
  }
  const record = matches[0];
  return toPluginRuntimeRecord(record);
}

function readManifestRuntimePluginRecord(plugin: unknown): ManifestRuntimePluginRecord | null {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }

  try {
    const candidate = plugin as {
      id?: unknown;
      origin?: unknown;
      rootDir?: unknown;
      source?: unknown;
    };
    const { id, origin, rootDir, source } = candidate;
    if (typeof id !== "string" || id.length === 0) {
      return null;
    }
    if (typeof source !== "string" || source.length === 0) {
      return null;
    }
    return {
      id,
      ...(isPluginOrigin(origin) ? { origin } : {}),
      ...(typeof rootDir === "string" && rootDir.length > 0 ? { rootDir } : {}),
      source,
    };
  } catch {
    return null;
  }
}

function isPluginOrigin(value: unknown): value is PluginOrigin {
  return value === "bundled" || value === "global" || value === "workspace" || value === "config";
}

function hasRuntimeEntryBaseNames(
  record: Pick<PluginRuntimeRecord, "rootDir" | "source">,
  entryBaseNames: string[],
) {
  try {
    return entryBaseNames.every(
      (entryBaseName) => resolvePluginRuntimeModulePath(record, entryBaseName) !== null,
    );
  } catch {
    return false;
  }
}

function toPluginRuntimeRecord(record: PluginRuntimeRecord): PluginRuntimeRecord {
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

function getPluginBoundarySourceLoader(modulePath: string, loaders: PluginModuleLoaderCache) {
  return getCachedPluginSourceModuleLoader({
    cache: loaders,
    modulePath,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic plugin boundary loaders use caller-supplied module types.
export function loadPluginBoundaryModule<TModule>(
  modulePath: string,
  loaders: PluginModuleLoaderCache,
  options: { origin?: PluginOrigin } = {},
): TModule {
  if (isJavaScriptModulePath(modulePath)) {
    const native = tryNativeRequireJavaScriptModule(modulePath, {
      allowWindows: true,
      fallbackOnNativeError: options.origin !== "bundled",
    });
    if (native.ok) {
      return native.moduleExport as TModule;
    }
    if (options.origin === "bundled") {
      throw new Error(`bundled plugin runtime module must load natively: ${modulePath}`);
    }
  } else if (options.origin === "bundled") {
    throw new Error(`bundled plugin runtime module must be built JavaScript: ${modulePath}`);
  }

  return getPluginBoundarySourceLoader(modulePath, loaders)(modulePath) as TModule;
}
