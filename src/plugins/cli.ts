import fs from "node:fs";
import type { Command } from "commander";
import { createJiti } from "jiti";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { removeCommandByName } from "../cli/program/command-tree.js";
import { registerLazyCommand } from "../cli/program/register-lazy-command.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";
import type { OpenClawPluginDefinition, OpenClawPluginModule, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
};

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return {
      definition,
      register: definition.register ?? definition.activate,
    };
  }
  return {};
}

function isChannelPluginDefinition(definition: OpenClawPluginDefinition | undefined): boolean {
  return Boolean(
    definition &&
    typeof definition === "object" &&
    "channelPlugin" in (definition as Record<string, unknown>),
  );
}

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
  loaderOptions?: Pick<PluginLoadOptions, "pluginSdkResolution">,
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

// Root help only needs parse-time CLI metadata. Capture `registerCli(...)`
// against a throwaway API so plugin runtime activation does not leak into
// `openclaw --help`.
function getPluginCliCommandDescriptorsFromMetadata(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): OpenClawPluginCliCommandDescriptor[] {
  const config = cfg ?? loadConfig();
  const resolvedEnv = env ?? process.env;
  const resolvedConfig = applyPluginAutoEnable({ config, env: resolvedEnv }).config;
  const workspaceDir = resolveAgentWorkspaceDir(
    resolvedConfig,
    resolveDefaultAgentId(resolvedConfig),
  );
  const normalized = normalizePluginsConfig(resolvedConfig.plugins);
  const discovery = discoverOpenClawPlugins({
    workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: false,
    env: resolvedEnv,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: resolvedConfig,
    workspaceDir,
    cache: false,
    env: resolvedEnv,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
  const getJiti = (modulePath: string) => {
    const tryNative = shouldPreferNativeJiti(modulePath);
    const aliasMap = buildPluginLoaderAliasMap(
      modulePath,
      process.argv[1],
      import.meta.url,
      undefined,
    );
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
  };

  const descriptors: OpenClawPluginCliCommandDescriptor[] = [];
  const seen = new Set<string>();
  let selectedMemoryPluginId: string | null = null;

  for (const manifest of manifestRegistry.plugins) {
    const enableState = resolveEffectiveEnableState({
      id: manifest.id,
      origin: manifest.origin,
      config: normalized,
      rootConfig: resolvedConfig,
      enabledByDefault: manifest.enabledByDefault,
    });
    if (!enableState.enabled || manifest.format === "bundle") {
      continue;
    }
    const memoryDecision = resolveMemorySlotDecision({
      id: manifest.id,
      kind: manifest.kind,
      slot: normalized.slots.memory,
      selectedId: selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      continue;
    }
    if (memoryDecision.selected && manifest.kind === "memory") {
      selectedMemoryPluginId = manifest.id;
    }

    const opened = openBoundaryFileSync({
      absolutePath: manifest.source,
      rootPath: manifest.rootDir,
      boundaryLabel: "plugin root",
      rejectHardlinks: manifest.origin !== "bundled",
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      continue;
    }

    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = getJiti(safeSource)(safeSource) as OpenClawPluginModule;
    } catch {
      continue;
    }

    const { definition, register } = resolvePluginModuleExport(mod);
    if (typeof register !== "function") {
      continue;
    }

    const captured = createCapturedPluginRegistration({
      config: resolvedConfig,
      registrationMode: isChannelPluginDefinition(definition) ? "setup-only" : "full",
    });
    try {
      void register(captured.api);
    } catch {
      continue;
    }

    for (const entry of captured.cliRegistrars) {
      for (const descriptor of entry.descriptors) {
        if (seen.has(descriptor.name)) {
          continue;
        }
        seen.add(descriptor.name);
        descriptors.push(descriptor);
      }
    }
  }

  return descriptors;
}

export function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): OpenClawPluginCliCommandDescriptor[] {
  try {
    return getPluginCliCommandDescriptorsFromMetadata(cfg, env);
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
