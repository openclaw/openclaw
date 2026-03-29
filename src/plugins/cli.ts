import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { removeCommandByName } from "../cli/program/command-tree.js";
import { registerLazyCommand } from "../cli/program/register-lazy-command.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";
import type { PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
};

function canRegisterPluginCliLazily(entry: {
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
}): boolean {
  if (entry.descriptors.length === 0) {
    return false;
  }
  const descriptorNames = new Set(entry.descriptors.map((descriptor) => descriptor.name));
  return entry.commands.every((command) => descriptorNames.has(command));
}

function loadPluginCliRegistry(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: Pick<
    PluginLoadOptions,
    "pluginSdkResolution" | "activate" | "cache" | "captureCliMetadataOnly"
  >,
) {
  const config = cfg ?? loadConfig();
  const resolvedConfig = applyPluginAutoEnable({ config, env: env ?? process.env }).config;
  const workspaceDir = resolveAgentWorkspaceDir(
    resolvedConfig,
    resolveDefaultAgentId(resolvedConfig),
  );
  const logger: PluginLogger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
  };
  return {
    config: resolvedConfig,
    workspaceDir,
    logger,
    registry: loadOpenClawPlugins({
      config: resolvedConfig,
      workspaceDir,
      env,
      logger,
      ...loaderOptions,
    }),
  };
}

export function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): OpenClawPluginCliCommandDescriptor[] {
  try {
    const { registry } = loadPluginCliRegistry(cfg, env, {
      activate: false,
      cache: false,
      captureCliMetadataOnly: true,
    });
    const seen = new Set<string>();
    const descriptors: OpenClawPluginCliCommandDescriptor[] = [];
    for (const entry of registry.cliRegistrars) {
      for (const descriptor of entry.descriptors) {
        if (seen.has(descriptor.name)) {
          continue;
        }
        seen.add(descriptor.name);
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  } catch {
    return [];
  }
}

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: Pick<PluginLoadOptions, "pluginSdkResolution">,
  options?: RegisterPluginCliOptions,
) {
  const { config, workspaceDir, logger, registry } = loadPluginCliRegistry(cfg, env, loaderOptions);
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? null;

  const existingCommands = new Set(program.commands.map((cmd) => cmd.name()));

  for (const entry of registry.cliRegistrars) {
    const registerEntry = async () => {
      await entry.register({
        program,
        config,
        workspaceDir,
        logger,
      });
    };

    if (primary && entry.commands.includes(primary)) {
      for (const commandName of new Set(entry.commands)) {
        removeCommandByName(program, commandName);
      }
      await registerEntry();
      for (const command of entry.commands) {
        existingCommands.add(command);
      }
      continue;
    }

    if (entry.commands.length > 0) {
      const overlaps = entry.commands.filter((command) => existingCommands.has(command));
      if (overlaps.length > 0) {
        log.debug(
          `plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(
            ", ",
          )})`,
        );
        continue;
      }
    }

    try {
      if (mode === "lazy" && canRegisterPluginCliLazily(entry)) {
        for (const descriptor of entry.descriptors) {
          registerLazyCommand({
            program,
            name: descriptor.name,
            description: descriptor.description,
            removeNames: entry.commands,
            register: async () => {
              await registerEntry();
            },
          });
        }
      } else {
        if (mode === "lazy" && entry.descriptors.length > 0) {
          log.debug(
            `plugin CLI lazy register fallback to eager (${entry.pluginId}): descriptors do not cover all command roots`,
          );
        }
        await registerEntry();
      }
      for (const command of entry.commands) {
        existingCommands.add(command);
      }
    } catch (err) {
      log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
    }
  }
}
