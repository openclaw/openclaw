import type { Command } from "commander";
import { loadConfig, readConfigFileSnapshot, type OpenClawConfig } from "../config/config.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  createPluginCliLogger,
  loadPluginCliDescriptors,
  loadPluginCliMetadataRegistryWithContext,
  loadPluginCliRegistrationEntriesWithDefaults,
  type PluginCliLoaderOptions,
  resolvePluginCliLoadContext,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
};

const logger = createPluginCliLogger();

export const loadValidatedConfigForPluginRegistration =
  async (): Promise<OpenClawConfig | null> => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return null;
    }
    return loadConfig();
  };

export async function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<OpenClawPluginCliCommandDescriptor[]> {
  return loadPluginCliDescriptors({ cfg, env, loaderOptions });
}

export async function getPluginCliCommandRoots(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<string[]> {
  try {
    const logger = createPluginCliLogger();
    const context = resolvePluginCliLoadContext({
      cfg,
      env,
      logger,
    });
    const { registry } = await loadPluginCliMetadataRegistryWithContext(context, loaderOptions);
    return [
      ...new Set(
        registry.cliRegistrars
          .flatMap((entry) => entry.commands)
          .map((command) => normalizeOptionalLowercaseString(command))
          .filter((command): command is string => Boolean(command)),
      ),
    ];
  } catch {
    return [];
  }
}

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
) {
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? null;

  await registerPluginCliCommandGroups(
    program,
    await loadPluginCliRegistrationEntriesWithDefaults({ cfg, env, loaderOptions }),
    {
      mode,
      primary,
      existingCommands: new Set(program.commands.map((cmd) => cmd.name())),
      logger,
    },
  );
}

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig | null> {
  const config = await loadValidatedConfigForPluginRegistration();
  if (!config) {
    return null;
  }
  await registerPluginCliCommands(program, config, env, loaderOptions, options);
  return config;
}
