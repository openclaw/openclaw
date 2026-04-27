import type { Command } from "commander";
import { cliCommandCatalog } from "../cli/command-catalog.js";
import { matchesCommandPath } from "../cli/command-path-matches.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLogger,
  loadPluginCliDescriptors,
  loadPluginCliMetadataEntries,
  loadPluginCliRegistrationEntriesWithDefaults,
  resolvePrimaryCommandPluginIdsForCli,
  type PluginCliLoaderOptions,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
};

const logger = createPluginCliLogger();

function isKnownCoreCommandPath(commandPath: string[]): boolean {
  return cliCommandCatalog.some((entry) =>
    matchesCommandPath(entry.commandPath.slice(), commandPath),
  );
}

export const loadValidatedConfigForPluginRegistration =
  async (): Promise<OpenClawConfig | null> => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return null;
    }
    return snapshot.config;
  };

export async function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<OpenClawPluginCliCommandDescriptor[]> {
  return loadPluginCliDescriptors({ cfg, env, loaderOptions });
}

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
) {
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? undefined;
  const primaryPluginIds =
    mode === "lazy" && primary
      ? resolvePrimaryCommandPluginIdsForCli({
          cfg,
          env,
          logger,
          primaryCommand: primary,
        })
      : [];
  const shouldUseMetadataOnlyEntries =
    mode === "lazy" &&
    !!primary &&
    primaryPluginIds.length === 0 &&
    isKnownCoreCommandPath([primary]);
  const entries = shouldUseMetadataOnlyEntries
    ? await loadPluginCliMetadataEntries({
        cfg,
        env,
        loaderOptions,
        primaryCommand: primary,
        logger,
      })
    : await loadPluginCliRegistrationEntriesWithDefaults({
        cfg,
        env,
        loaderOptions,
        primaryCommand: primary,
        logger,
      });

  await registerPluginCliCommandGroups(program, entries, {
    mode,
    primary,
    existingCommands: new Set(program.commands.map((cmd) => cmd.name())),
    logger,
  });
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
