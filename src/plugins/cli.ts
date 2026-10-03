import type { Command } from "commander";
import { getRuntimeConfigSnapshot, readConfigFileSnapshot } from "../config/config.js";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
} from "../config/io.invalid-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLoadSession,
  type PluginCliLoadSession,
  loadPluginCliRegistrationEntriesWithDefaults,
  type PluginCliLoaderOptions,
} from "./cli-registry-loader.js";
import { getPluginCache } from "./plugin-cache.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
import { createPluginRuntimeLoaderLogger } from "./runtime/load-context.js";

type PluginCliRegistrationMode = "eager" | "lazy" | "metadata";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
  skipPluginValidation?: boolean;
  session?: PluginCliLoadSession;
};

const logger = createPluginRuntimeLoaderLogger();

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig> {
  const session = options?.session ?? createPluginCliLoadSession(getPluginCache());
  try {
    const snapshot = await session.readConfig(() =>
      readConfigFileSnapshot({ skipPluginValidation: options?.skipPluginValidation }),
    );
    if (!snapshot.valid) {
      throw createInvalidConfigError(snapshot.path, formatInvalidConfigDetails(snapshot.issues));
    }
    const cfg = getRuntimeConfigSnapshot() ?? snapshot.runtimeConfig;
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
    await registerPluginCliCommandGroups(program, groups, {
      mode: mode === "metadata" ? "lazy" : mode,
      // Parent help needs descriptors; actual expansion retains the fresh loader above.
      primary: mode === "metadata" ? undefined : primary,
      // Include aliases: alias-only root names (cron|automations, tui|terminal)
      // are owned commands too; a plugin claiming one would crash registration.
      existingCommands: new Set(program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()])),
      logger,
    });
    return cfg;
  } finally {
    if (!options?.session) {
      session.close();
    }
  }
}
