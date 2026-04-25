import { collectUniqueCommandDescriptors } from "../cli/program/command-descriptor-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import type { PluginRegistry } from "./registry.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type {
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliContext,
  PluginLogger,
} from "./types.js";

export type PluginCliLoaderOptions = Pick<PluginLoadOptions, "pluginSdkResolution">;

export type PluginCliPublicLoadParams = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loaderOptions?: PluginCliLoaderOptions;
  logger?: PluginLogger;
  primaryCommand?: string;
};

export type PluginCliLoadContext = PluginRuntimeLoadContext;

export type PluginCliRegistryLoadResult = PluginCliLoadContext & {
  registry: PluginRegistry;
};

export type PluginCliCommandGroupEntry = {
  pluginId: string;
  placeholders: readonly OpenClawPluginCliCommandDescriptor[];
  names: readonly string[];
  register: (program: OpenClawPluginCliContext["program"]) => Promise<void>;
};

export function createPluginCliLogger(): PluginLogger {
  return createPluginRuntimeLoaderLogger();
}

function resolvePluginCliLogger(logger?: PluginLogger): PluginLogger {
  return logger ?? createPluginCliLogger();
}

function isIgnoredAsyncRegisterDiagnosticMessage(message: string): boolean {
  if (message === "plugin register returned a promise; async registration is ignored") {
    return true;
  }
  // Current loader: `runPluginRegisterSync` throws `plugin register must be synchronous`, then
  // `recordPluginError` prefixes with `plugin failed during register: `.
  if (message.includes("plugin register must be synchronous")) {
    return true;
  }
  return false;
}

function hasIgnoredAsyncPluginRegistration(registry: PluginRegistry): boolean {
  return (registry.diagnostics ?? []).some((entry) =>
    isIgnoredAsyncRegisterDiagnosticMessage(entry.message),
  );
}

function mergeCliRegistrars(params: {
  runtimeRegistry: PluginRegistry;
  metadataRegistry: PluginRegistry;
}): PluginRegistry["cliRegistrars"] {
  const runtimeCommands = new Set(
    params.runtimeRegistry.cliRegistrars.flatMap((entry) => entry.commands),
  );
  return [
    ...params.runtimeRegistry.cliRegistrars,
    ...params.metadataRegistry.cliRegistrars.filter(
      (entry) => !entry.commands.some((command) => runtimeCommands.has(command)),
    ),
  ];
}

function sameCommandRoots(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftSorted = [...left].toSorted();
  const rightSorted = [...right].toSorted();
  return leftSorted.every((command, index) => command === rightSorted[index]);
}

function canPreferMetadataCliRegistrar(entry: PluginRegistry["cliRegistrars"][number]): boolean {
  // `registerCli` can record command-only CLIs: `commands` from opts with no descriptor
  // rows, but a real non-stub `register` body. The placeholder pattern for “roots only”
  // is still `() => {}` (zero-arity), which we must not swap in for the lazy primary.
  // (A no-op `(_ctx) => {}` cannot be distinguished; zero-ary stubs are the common case
  // called out in plugin metadata.)
  if (entry.register.length === 0) {
    return false;
  }
  return true;
}

function preferMetadataCliRegistrarsForCommands(params: {
  cliRegistrars: PluginRegistry["cliRegistrars"];
  metadataRegistry: PluginRegistry;
  preferredCommands: readonly string[];
}): PluginRegistry["cliRegistrars"] | null {
  const preferredCommands = new Set(params.preferredCommands);
  if (preferredCommands.size === 0) {
    return null;
  }

  let replacedAny = false;
  const nextCliRegistrars = params.cliRegistrars.map((entry) => {
    if (!entry.commands.some((command) => preferredCommands.has(command))) {
      return entry;
    }

    const metadataEntry = params.metadataRegistry.cliRegistrars.find(
      (candidate) =>
        candidate.pluginId === entry.pluginId &&
        sameCommandRoots(candidate.commands, entry.commands),
    );
    if (!metadataEntry || !canPreferMetadataCliRegistrar(metadataEntry)) {
      return entry;
    }

    replacedAny = true;
    return metadataEntry;
  });

  return replacedAny ? nextCliRegistrars : null;
}

function canPreferScopedMetadataRegistry(params: {
  runtimeRegistry: PluginRegistry;
  scopedPluginIds: readonly string[];
}): boolean {
  if (params.scopedPluginIds.length === 0) {
    return false;
  }

  // Duplicate plugin ids append disabled "overridden by …" records after the winner.
  // Prefer the first registry row per id so we do not misread the trailing duplicate.
  const winningOriginsById = new Map<string, PluginRegistry["plugins"][number]["origin"]>();
  for (const plugin of params.runtimeRegistry.plugins) {
    if (!winningOriginsById.has(plugin.id)) {
      winningOriginsById.set(plugin.id, plugin.origin);
    }
  }
  return params.scopedPluginIds.every((pluginId) => winningOriginsById.get(pluginId) === "bundled");
}

function resolvePluginCliLoaderParams(
  context: PluginCliLoadContext,
  params?: { primaryCommand?: string },
  loaderOptions?: PluginCliLoaderOptions,
  /** e.g. lazy primary CLI: avoid activation + global registry cache in `loadOpenClawPlugins`. */
  extraRuntimeOptions?: { activate: boolean; cache: boolean },
): {
  scopedPluginIds: string[];
  loadOptions: ReturnType<typeof buildPluginRuntimeLoadOptions>;
} {
  const onlyPluginIds = resolvePrimaryCommandPluginIds(context, params?.primaryCommand);
  return {
    scopedPluginIds: onlyPluginIds,
    loadOptions: buildPluginRuntimeLoadOptions(context, {
      ...loaderOptions,
      ...(onlyPluginIds.length > 0 ? { onlyPluginIds } : {}),
      ...(extraRuntimeOptions ?? {}),
    }),
  };
}

function resolvePrimaryCommandPluginIds(
  context: PluginCliLoadContext,
  primaryCommand: string | undefined,
): string[] {
  const normalizedPrimary = primaryCommand?.trim();
  if (!normalizedPrimary) {
    return [];
  }
  return resolveManifestActivationPluginIds({
    trigger: {
      kind: "command",
      command: normalizedPrimary,
    },
    config: context.activationSourceConfig,
    workspaceDir: context.workspaceDir,
    env: context.env,
  });
}

export function resolvePluginCliLoadContext(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger: PluginLogger;
}): PluginCliLoadContext {
  return resolvePluginRuntimeLoadContext({
    config: params.cfg,
    env: params.env,
    logger: params.logger,
  });
}

export async function loadPluginCliMetadataRegistryWithContext(
  context: PluginCliLoadContext,
  params?: { primaryCommand?: string },
  loaderOptions?: PluginCliLoaderOptions,
): Promise<PluginCliRegistryLoadResult> {
  const { loadOptions } = resolvePluginCliLoaderParams(context, params, loaderOptions);
  return {
    ...context,
    registry: await loadOpenClawPluginCliRegistry(loadOptions),
  };
}

export async function loadPluginCliCommandRegistryWithContext(params: {
  context: PluginCliLoadContext;
  primaryCommand?: string;
  loaderOptions?: PluginCliLoaderOptions;
  onMetadataFallbackError: (error: unknown) => void;
  preferMetadataCommands?: readonly string[];
}): Promise<PluginCliRegistryLoadResult> {
  const runtimeLoad = resolvePluginCliLoaderParams(
    params.context,
    { primaryCommand: params.primaryCommand },
    params.loaderOptions,
    { activate: false, cache: false },
  );
  // Full runtime load must precede the optional cli-metadata merge: we need runtime
  // diagnostics for `hasIgnoredAsyncPluginRegistration`, and we need runtime CLI command
  // roots so `preferMetadataCliRegistrarsForCommands` can keep richer runtime registrars
  // when metadata only covers a subset of those roots (see cli.test.ts partial-coverage case).
  const runtimeRegistry = loadOpenClawPlugins(runtimeLoad.loadOptions);
  const shouldPreferScopedMetadata =
    (params.preferMetadataCommands?.length ?? 0) > 0 &&
    canPreferScopedMetadataRegistry({
      runtimeRegistry,
      scopedPluginIds: runtimeLoad.scopedPluginIds,
    });

  const shouldTryMetadataRegistry =
    hasIgnoredAsyncPluginRegistration(runtimeRegistry) || shouldPreferScopedMetadata;

  if (!shouldTryMetadataRegistry) {
    return {
      ...params.context,
      registry: runtimeRegistry,
    };
  }

  try {
    const metadataRegistry = await loadOpenClawPluginCliRegistry(runtimeLoad.loadOptions);
    const mergedRegistry = hasIgnoredAsyncPluginRegistration(runtimeRegistry)
      ? {
          ...runtimeRegistry,
          cliRegistrars: mergeCliRegistrars({
            runtimeRegistry,
            metadataRegistry,
          }),
        }
      : runtimeRegistry;
    const preferredCliRegistrars = preferMetadataCliRegistrarsForCommands({
      cliRegistrars: mergedRegistry.cliRegistrars,
      metadataRegistry,
      preferredCommands: params.preferMetadataCommands ?? [],
    });
    return {
      ...params.context,
      registry: preferredCliRegistrars
        ? {
            ...mergedRegistry,
            cliRegistrars: preferredCliRegistrars,
          }
        : mergedRegistry,
    };
  } catch (error) {
    params.onMetadataFallbackError(error);
    return {
      ...params.context,
      registry: runtimeRegistry,
    };
  }
}

function buildPluginCliCommandGroupEntries(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir: string | undefined;
  logger: PluginLogger;
}): PluginCliCommandGroupEntry[] {
  return params.registry.cliRegistrars.map((entry) => ({
    pluginId: entry.pluginId,
    placeholders: entry.descriptors,
    names: entry.commands,
    register: async (program) => {
      await entry.register({
        program,
        config: params.config,
        workspaceDir: params.workspaceDir,
        logger: params.logger,
      });
    },
  }));
}

function logPluginCliMetadataFallbackError(logger: PluginLogger, error: unknown) {
  logger.warn(`plugin CLI metadata fallback failed: ${String(error)}`);
}

export async function loadPluginCliDescriptors(
  params: PluginCliPublicLoadParams,
): Promise<OpenClawPluginCliCommandDescriptor[]> {
  try {
    const logger = resolvePluginCliLogger(params.logger);
    const context = resolvePluginCliLoadContext({
      cfg: params.cfg,
      env: params.env,
      logger,
    });
    const { registry } = await loadPluginCliMetadataRegistryWithContext(
      context,
      { primaryCommand: params.primaryCommand },
      params.loaderOptions,
    );
    return collectUniqueCommandDescriptors(
      registry.cliRegistrars.map((entry) => entry.descriptors),
    );
  } catch {
    return [];
  }
}

export async function loadPluginCliRegistrationEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loaderOptions?: PluginCliLoaderOptions;
  logger?: PluginLogger;
  primaryCommand?: string;
  onMetadataFallbackError: (error: unknown) => void;
  preferMetadataCommands?: readonly string[];
}): Promise<PluginCliCommandGroupEntry[]> {
  const resolvedLogger = resolvePluginCliLogger(params.logger);
  const context = resolvePluginCliLoadContext({
    cfg: params.cfg,
    env: params.env,
    logger: resolvedLogger,
  });
  const { config, workspaceDir, logger, registry } = await loadPluginCliCommandRegistryWithContext({
    context,
    primaryCommand: params.primaryCommand,
    loaderOptions: params.loaderOptions,
    onMetadataFallbackError: params.onMetadataFallbackError,
    preferMetadataCommands: params.preferMetadataCommands,
  });
  return buildPluginCliCommandGroupEntries({
    registry,
    config,
    workspaceDir,
    logger,
  });
}

export async function loadPluginCliRegistrationEntriesWithDefaults(
  params: PluginCliPublicLoadParams & { preferMetadataCommands?: readonly string[] },
): Promise<PluginCliCommandGroupEntry[]> {
  const logger = resolvePluginCliLogger(params.logger);
  return loadPluginCliRegistrationEntries({
    ...params,
    logger,
    onMetadataFallbackError: (error) => {
      logPluginCliMetadataFallbackError(logger, error);
    },
  });
}
