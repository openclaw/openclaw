import type { Command } from "commander";
import { setCommandJsonMode } from "../cli/program/json-mode.js";
import {
  findCommandGroupEntry,
  getCommandGroupNames,
  registerLazyCommandGroup,
  removeCommandGroupNames,
} from "../cli/program/register-command-groups.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
} from "../config/io.invalid-config.js";
import { loadPinnedRuntimeConfigAsync } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLoadSession,
  type PluginCliCommandGroupEntry,
  type PluginCliLoadSession,
  loadPluginCliRegistrationEntriesWithDefaults,
  type PluginCliLoaderOptions,
} from "./cli-registry-loader.js";
import { getPluginCache } from "./plugin-cache.js";
import { pluginRuntimeLoaderLogger as logger } from "./runtime/load-context.js";
import type { OpenClawPluginCliRootCommandDescriptor } from "./types.js";

type PluginCliRegistrationMode = "eager" | "lazy" | "metadata";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
  skipPluginValidation?: boolean;
  session?: PluginCliLoadSession;
};

function canRegisterPluginCliLazily(entry: PluginCliCommandGroupEntry): boolean {
  if (entry.placeholders.length === 0) {
    return false;
  }
  const descriptorNames = new Set(entry.placeholders.map((descriptor) => descriptor.name));
  return getCommandGroupNames(entry).every((command) => descriptorNames.has(command));
}

function findCommandByPath(program: Command, path: readonly string[]): Command | null {
  let current = program;
  for (const segment of path) {
    const next = current.commands.find(
      (command) => command.name() === segment || command.aliases().includes(segment),
    );
    if (!next) {
      return null;
    }
    current = next;
  }
  return current;
}

function applyMachineOutputMode(
  program: Command,
  descriptor: OpenClawPluginCliRootCommandDescriptor,
): void {
  if (!descriptor.machineOutput) {
    return;
  }
  const command = program.commands.find((candidate) => candidate.name() === descriptor.name);
  if (!command) {
    return;
  }
  setCommandJsonMode(
    command,
    "output",
    ({ argv, stdoutIsTTY }) => descriptor.machineOutput?.({ argv, stdoutIsTTY }) === true,
  );
}

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig> {
  const session = options?.session ?? createPluginCliLoadSession(getPluginCache());
  try {
    const snapshot = await session.readConfig(() =>
      readConfigFileSnapshot({
        observe: false,
        skipPluginValidation: options?.skipPluginValidation,
      }),
    );
    if (!snapshot.valid) {
      throw createInvalidConfigError(snapshot.path, formatInvalidConfigDetails(snapshot.issues));
    }
    const cfg = await loadPinnedRuntimeConfigAsync(async () => ({
      config: snapshot.runtimeConfig,
    }));
    const mode = options?.mode ?? "eager";
    const primary = options?.primary ?? undefined;
    const entries = await loadPluginCliRegistrationEntriesWithDefaults(
      {
        cfg,
        env,
        loaderOptions,
        primaryCommand: primary,
        session,
      },
      mode === "metadata" ? "metadata" : "runtime",
    );

    const groups = entries.map((entry) => {
      if (
        mode === "eager" ||
        (mode === "lazy" &&
          primary &&
          (entry.parentPath[0] === primary ||
            entry.names.includes(primary) ||
            entry.placeholders.some((descriptor) => descriptor.name === primary)))
      ) {
        return entry;
      }
      // Deferred expansion gets fresh preparation in the parsing generation. Never retain
      // startup registrars past close, including help/completion on a prepared program.
      return Object.assign({}, entry, {
        register: async (target: Command) => {
          const deferred = createPluginCliLoadSession(getPluginCache(), {
            resources: session.resources,
          });
          try {
            const fresh = await loadPluginCliRegistrationEntriesWithDefaults({
              cfg,
              env,
              loaderOptions,
              primaryCommand: mode === "metadata" ? primary : undefined,
              session: deferred,
            });
            const match = fresh.find(
              (candidate) =>
                candidate.pluginId === entry.pluginId &&
                candidate.parentPath.join("\0") === entry.parentPath.join("\0") &&
                candidate.names.join("\0") === entry.names.join("\0"),
            );
            if (!match) {
              throw new Error(
                `Plugin CLI registration is no longer available (${entry.pluginId}).`,
              );
            }
            await match.register(target);
          } finally {
            deferred.close();
          }
        },
      });
    });
    const registrationMode = mode === "metadata" ? "lazy" : mode;
    // Parent help needs descriptors; actual expansion retains the fresh loader above.
    const registrationPrimary = mode === "metadata" ? undefined : primary;
    // Include aliases: alias-only root names (cron|automations, tui|terminal)
    // are owned commands too; a plugin claiming one would crash registration.
    const registeredRoots = new Set(
      program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]),
    );
    for (const entry of groups) {
      const parentPath = entry.parentPath ?? [];
      const targetProgram = findCommandByPath(program, parentPath);
      if (!targetProgram) {
        logger.debug?.(
          `plugin CLI register skipped (${entry.pluginId}): parent command missing (${parentPath.join(
            " ",
          )})`,
        );
        continue;
      }
      const existingCommands =
        parentPath.length === 0
          ? registeredRoots
          : new Set(
              targetProgram.commands.flatMap((command) => [command.name(), ...command.aliases()]),
            );
      const registerEntry = async () => {
        await entry.register(targetProgram);
        for (const descriptor of entry.placeholders) {
          applyMachineOutputMode(targetProgram, descriptor);
        }
        for (const command of getCommandGroupNames(entry)) {
          existingCommands.add(command);
        }
      };

      if (
        registrationPrimary &&
        (parentPath[0] === registrationPrimary ||
          findCommandGroupEntry([entry], registrationPrimary))
      ) {
        removeCommandGroupNames(targetProgram, entry);
        await registerEntry();
        continue;
      }

      const overlaps = getCommandGroupNames(entry).filter((command) =>
        existingCommands.has(command),
      );
      if (overlaps.length > 0) {
        logger.debug?.(
          `plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(
            ", ",
          )})`,
        );
        continue;
      }

      try {
        if (registrationMode === "lazy" && canRegisterPluginCliLazily(entry)) {
          for (const placeholder of entry.placeholders) {
            registerLazyCommandGroup(
              targetProgram,
              { ...entry, register: registerEntry },
              placeholder,
            );
            applyMachineOutputMode(targetProgram, placeholder);
          }
          continue;
        }

        if (registrationMode === "lazy" && entry.placeholders.length > 0) {
          logger.debug?.(
            `plugin CLI lazy register fallback to eager (${entry.pluginId}): descriptors do not cover all command roots`,
          );
        }
        await registerEntry();
      } catch (error) {
        logger.warn(`plugin CLI register failed (${entry.pluginId}): ${String(error)}`);
      }
    }
    return cfg;
  } finally {
    if (!options?.session) {
      session.close();
    }
  }
}
