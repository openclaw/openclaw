import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { collectUniqueCommandDescriptors } from "../cli/program/command-descriptor-utils.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import type { PluginRegistry } from "./registry.js";
import type {
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliContext,
  PluginLogger,
} from "./types.js";

const log = createSubsystemLogger("plugins");

export type PluginCliLoaderOptions = Pick<PluginLoadOptions, "pluginSdkResolution">;

export type PluginCliPublicLoadParams = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loaderOptions?: PluginCliLoaderOptions;
  logger?: PluginLogger;
};

export type PluginCliLoadContext = {
  rawConfig: OpenClawConfig;
  config: OpenClawConfig;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  workspaceDir: string | undefined;
  logger: PluginLogger;
};

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
  return {
    info: (message: string) => log.info(message),
    warn: (message: string) => log.warn(message),
    error: (message: string) => log.error(message),
    debug: (message: string) => log.debug(message),
  };
}

function resolvePluginCliLogger(logger?: PluginLogger): PluginLogger {
  return logger ?? createPluginCliLogger();
}

function hasIgnoredAsyncPluginRegistration(registry: PluginRegistry): boolean {
  return (registry.diagnostics ?? []).some(
    (entry) =>
      entry.message === "plugin register returned a promise; async registration is ignored",
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

function buildPluginCliLoaderParams(
  context: PluginCliLoadContext,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
) {
  return {
    config: context.config,
    activationSourceConfig: context.rawConfig,
    autoEnabledReasons: context.autoEnabledReasons,
    workspaceDir: context.workspaceDir,
    env,
    logger: context.logger,
    ...loaderOptions,
  };
}

export function resolvePluginCliLoadContext(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger: PluginLogger;
}): PluginCliLoadContext {
  const rawConfig = params.cfg ?? loadConfig();
  const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env: params.env ?? process.env });
  const config = autoEnabled.config;
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  return {
    rawConfig,
    config,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    logger: params.logger,
  };
}

export async function loadPluginCliMetadataRegistryWithContext(
  context: PluginCliLoadContext,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<PluginCliRegistryLoadResult> {
  return {
    ...context,
    registry: await loadOpenClawPluginCliRegistry(
      buildPluginCliLoaderParams(context, env, loaderOptions),
    ),
  };
}

export async function loadPluginCliCommandRegistryWithContext(params: {
  context: PluginCliLoadContext;
  env?: NodeJS.ProcessEnv;
  loaderOptions?: PluginCliLoaderOptions;
  onMetadataFallbackError: (error: unknown) => void;
}): Promise<PluginCliRegistryLoadResult> {
  const runtimeRegistry = loadOpenClawPlugins(
    buildPluginCliLoaderParams(params.context, params.env, params.loaderOptions),
  );

  if (!hasIgnoredAsyncPluginRegistration(runtimeRegistry)) {
    return {
      ...params.context,
      registry: runtimeRegistry,
    };
  }

  try {
    const metadataRegistry = await loadOpenClawPluginCliRegistry(
      buildPluginCliLoaderParams(params.context, params.env, params.loaderOptions),
    );
    return {
      ...params.context,
      registry: {
        ...runtimeRegistry,
        cliRegistrars: mergeCliRegistrars({
          runtimeRegistry,
          metadataRegistry,
        }),
      },
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
      params.env,
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
  onMetadataFallbackError: (error: unknown) => void;
}): Promise<PluginCliCommandGroupEntry[]> {
  const resolvedLogger = resolvePluginCliLogger(params.logger);
  const context = resolvePluginCliLoadContext({
    cfg: params.cfg,
    env: params.env,
    logger: resolvedLogger,
  });
  const { config, workspaceDir, logger, registry } = await loadPluginCliCommandRegistryWithContext({
    context,
    env: params.env,
    loaderOptions: params.loaderOptions,
    onMetadataFallbackError: params.onMetadataFallbackError,
  });
  return buildPluginCliCommandGroupEntries({
    registry,
    config,
    workspaceDir,
    logger,
  });
}

export async function loadPluginCliRegistrationEntriesWithDefaults(
  params: PluginCliPublicLoadParams,
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
