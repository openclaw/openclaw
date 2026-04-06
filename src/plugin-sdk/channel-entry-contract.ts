import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { emptyChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type { ChannelConfigSchema, ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "../plugins/sdk-alias.js";
import type { AnyAgentTool, OpenClawPluginApi, PluginCommandContext } from "../plugins/types.js";

export type { AnyAgentTool, OpenClawPluginApi, PluginCommandContext };

type ChannelEntryConfigSchema<TPlugin> =
  TPlugin extends ChannelPlugin<unknown>
    ? NonNullable<TPlugin["configSchema"]>
    : ChannelConfigSchema;

type BundledEntryModuleRef = {
  specifier: string;
  exportName?: string;
};

type DefineBundledChannelEntryOptions<TPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  importMetaUrl: string;
  plugin: BundledEntryModuleRef;
  configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
  runtime?: BundledEntryModuleRef;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

type DefineBundledChannelSetupEntryOptions = {
  importMetaUrl: string;
  plugin: BundledEntryModuleRef;
};

export type BundledChannelEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  configSchema: ChannelEntryConfigSchema<TPlugin>;
  register: (api: OpenClawPluginApi) => void;
  loadChannelPlugin: () => TPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

export type BundledChannelSetupEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: () => TPlugin;
};

const nodeRequire = createRequire(import.meta.url);
const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
const loadedModuleExports = new Map<string, unknown>();

function resolveSpecifierCandidates(modulePath: string): string[] {
  const ext = path.extname(modulePath).toLowerCase();
  if (ext === ".js") {
    return [modulePath, modulePath.slice(0, -3) + ".ts"];
  }
  if (ext === ".mjs") {
    return [modulePath, modulePath.slice(0, -4) + ".mts"];
  }
  if (ext === ".cjs") {
    return [modulePath, modulePath.slice(0, -4) + ".cts"];
  }
  return [modulePath];
}

function resolveEntryBoundaryRoot(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

function resolveBundledEntryModulePath(importMetaUrl: string, specifier: string): string {
  const importerPath = fileURLToPath(importMetaUrl);
  const resolved = path.resolve(path.dirname(importerPath), specifier);
  const boundaryRoot = resolveEntryBoundaryRoot(importMetaUrl);
  const candidate =
    resolveSpecifierCandidates(resolved).find((entry) => fs.existsSync(entry)) ?? resolved;
  const opened = openBoundaryFileSync({
    absolutePath: candidate,
    rootPath: boundaryRoot,
    boundaryLabel: "plugin root",
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error(`plugin entry path escapes plugin root: ${specifier}`);
  }
  fs.closeSync(opened.fd);
  return opened.path;
}

function getJiti(modulePath: string) {
  const tryNative =
    shouldPreferNativeJiti(modulePath) || modulePath.includes(`${path.sep}dist${path.sep}`);
  const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
  const cacheKey = JSON.stringify({
    tryNative,
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
  });
  const cached = jitiLoaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const loader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  jitiLoaders.set(cacheKey, loader);
  return loader;
}

function loadBundledEntryModuleSync(importMetaUrl: string, specifier: string): unknown {
  const modulePath = resolveBundledEntryModulePath(importMetaUrl, specifier);
  const cached = loadedModuleExports.get(modulePath);
  if (cached !== undefined) {
    return cached;
  }
  let loaded: unknown;
  if (
    process.platform === "win32" &&
    modulePath.includes(`${path.sep}dist${path.sep}`) &&
    [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase())
  ) {
    try {
      loaded = nodeRequire(modulePath);
    } catch {
      loaded = getJiti(modulePath)(modulePath);
    }
  } else {
    loaded = getJiti(modulePath)(modulePath);
  }
  loadedModuleExports.set(modulePath, loaded);
  return loaded;
}

export function loadBundledEntryExportSync<T>(
  importMetaUrl: string,
  reference: BundledEntryModuleRef,
): T {
  const loaded = loadBundledEntryModuleSync(importMetaUrl, reference.specifier);
  const resolved =
    loaded && typeof loaded === "object" && "default" in (loaded as Record<string, unknown>)
      ? (loaded as { default: unknown }).default
      : loaded;
  if (!reference.exportName) {
    return resolved as T;
  }
  const record = (resolved ?? loaded) as Record<string, unknown> | undefined;
  if (!record || !(reference.exportName in record)) {
    throw new Error(
      `missing export "${reference.exportName}" from bundled entry module ${reference.specifier}`,
    );
  }
  return record[reference.exportName] as T;
}

export function defineBundledChannelEntry<TPlugin = ChannelPlugin>({
  id,
  name,
  description,
  importMetaUrl,
  plugin,
  configSchema,
  runtime,
  registerCliMetadata,
  registerFull,
}: DefineBundledChannelEntryOptions<TPlugin>): BundledChannelEntryContract<TPlugin> {
  const resolvedConfigSchema: ChannelEntryConfigSchema<TPlugin> =
    typeof configSchema === "function"
      ? configSchema()
      : ((configSchema ?? emptyChannelConfigSchema()) as ChannelEntryConfigSchema<TPlugin>);
  const loadChannelPlugin = () => loadBundledEntryExportSync<TPlugin>(importMetaUrl, plugin);
  const setChannelRuntime = runtime
    ? (pluginRuntime: PluginRuntime) => {
        const setter = loadBundledEntryExportSync<(runtime: PluginRuntime) => void>(
          importMetaUrl,
          runtime,
        );
        setter(pluginRuntime);
      }
    : undefined;

  return {
    kind: "bundled-channel-entry",
    id,
    name,
    description,
    configSchema: resolvedConfigSchema,
    register(api: OpenClawPluginApi) {
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(api);
        return;
      }
      setChannelRuntime?.(api.runtime);
      api.registerChannel({ plugin: loadChannelPlugin() as ChannelPlugin });
      if (api.registrationMode !== "full") {
        return;
      }
      registerCliMetadata?.(api);
      registerFull?.(api);
    },
    loadChannelPlugin,
    ...(setChannelRuntime ? { setChannelRuntime } : {}),
  };
}

export function defineBundledChannelSetupEntry<TPlugin = ChannelPlugin>({
  importMetaUrl,
  plugin,
}: DefineBundledChannelSetupEntryOptions): BundledChannelSetupEntryContract<TPlugin> {
  return {
    kind: "bundled-channel-setup-entry",
    loadSetupPlugin: () => loadBundledEntryExportSync<TPlugin>(importMetaUrl, plugin),
  };
}
