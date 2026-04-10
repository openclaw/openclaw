import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { hasMemoryRuntime } from "../plugins/memory-state.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { shouldEnsureCliPathForCommandPath } from "./command-startup-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

async function closeCliMemoryManagers(): Promise<void> {
  if (!hasMemoryRuntime()) {
    return;
  }
  try {
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes.
  }
}

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  return shouldEnsureCliPathForCommandPath(invocation.commandPath);
}

export function shouldUseRootHelpFastPath(argv: string[]): boolean {
  return resolveCliArgvInvocation(argv).isRootHelpInvocation;
}

async function resolveBundledPluginCliRootCommand(
  commandName: string,
  config?: OpenClawConfig,
): Promise<string | null> {
  const normalizedCommandName = normalizeLowercaseStringOrEmpty(commandName);
  if (!normalizedCommandName) {
    return null;
  }

  const pluginRegistry = loadPluginManifestRegistry({ config });
  const bundledPluginIds = Array.from(
    new Set(
      pluginRegistry.plugins
        .filter((plugin) => plugin.origin === "bundled")
        .map((plugin) => normalizeLowercaseStringOrEmpty(plugin.id))
        .filter(Boolean),
    ),
  );
  if (bundledPluginIds.length === 0) {
    return null;
  }

  const {
    createPluginCliLogger,
    loadPluginCliMetadataRegistryWithContext,
    resolvePluginCliLoadContext,
  } = await import("../plugins/cli-registry-loader.js");
  const detectionEntries = { ...config?.plugins?.entries };
  for (const pluginId of bundledPluginIds) {
    detectionEntries[pluginId] = {
      ...config?.plugins?.entries?.[pluginId],
      enabled: true,
    };
  }
  const detectionConfig: OpenClawConfig = {
    ...config,
    plugins: {
      ...config?.plugins,
      ...(config?.plugins?.enabled === false ? { enabled: true } : {}),
      allow: bundledPluginIds,
      deny: [],
      entries: detectionEntries,
    },
  };
  const context = resolvePluginCliLoadContext({
    cfg: detectionConfig,
    logger: createPluginCliLogger(),
  });
  const { registry } = await loadPluginCliMetadataRegistryWithContext(context);
  const matchedPluginId =
    registry.cliRegistrars.find(
      (entry) =>
        bundledPluginIds.includes(normalizeLowercaseStringOrEmpty(entry.pluginId)) &&
        entry.commands.some(
          (name) => normalizeLowercaseStringOrEmpty(name) === normalizedCommandName,
        ),
    )?.pluginId ?? null;
  return matchedPluginId ? normalizeLowercaseStringOrEmpty(matchedPluginId) : null;
}

async function resolveMissingBundledPluginCliRoot(
  commandName: string,
  config?: OpenClawConfig,
): Promise<string | null> {
  try {
    return await resolveBundledPluginCliRootCommand(commandName, config);
  } catch {
    // Unknown-command handling should degrade gracefully if metadata probing fails.
    return null;
  }
}

export async function resolveMissingPluginCommandMessage(
  commandName: string,
  config?: OpenClawConfig,
): Promise<string | null> {
  const normalizedCommandName = normalizeLowercaseStringOrEmpty(commandName);
  if (!normalizedCommandName) {
    return null;
  }
  const normalizedPluginId = await resolveMissingBundledPluginCliRoot(
    normalizedCommandName,
    config,
  );
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeOptionalLowercaseString(entry))
          .filter(Boolean)
      : [];
  const blockedByAllowlist = allow.length > 0 && !allow.includes(normalizedPluginId);
  const explicitlyDisabled = config?.plugins?.entries?.[normalizedPluginId]?.enabled === false;
  if (!blockedByAllowlist && !explicitlyDisabled) {
    return null;
  }
  if (blockedByAllowlist) {
    return (
      `The \`openclaw ${normalizedCommandName}\` command is unavailable because ` +
      `\`plugins.allow\` excludes plugin "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
      `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    );
  }
  if (explicitlyDisabled) {
    return (
      `The \`openclaw ${normalizedCommandName}\` command is unavailable because ` +
      `\`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want ` +
      "the bundled plugin CLI surface."
    );
  }
  return null;
}

function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

export async function runCli(argv: string[] = process.argv) {
  const originalArgv = normalizeWindowsArgv(argv);
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    throw new Error(parsedContainer.error);
  }
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  const containerTarget = maybeRunCliInContainer(originalArgv);
  if (containerTarget.handled) {
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }
  let normalizedArgv = parsedProfile.argv;

  if (shouldLoadCliDotEnv()) {
    const { loadCliDotEnv } = await import("./dotenv.js");
    loadCliDotEnv({ quiet: true });
  }
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  try {
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedRootHelpText } = await import("./root-help-metadata.js");
      if (!outputPrecomputedRootHelpText()) {
        const { outputRootHelp } = await import("./program/root-help.js");
        await outputRootHelp();
      }
      return;
    }

    if (await tryRouteCli(normalizedArgv)) {
      return;
    }

    // Capture all console output into structured logs while keeping stdout/stderr behavior.
    enableConsoleCapture();

    const [{ buildProgram }, { installUnhandledRejectionHandler }, { restoreTerminalState }] =
      await Promise.all([
        import("./program.js"),
        import("../infra/unhandled-rejections.js"),
        import("../terminal/restore.js"),
      ]);
    const program = buildProgram();

    // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
    // These log the error and exit gracefully instead of crashing without trace.
    installUnhandledRejectionHandler();

    process.on("uncaughtException", (error) => {
      console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
      restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
      process.exit(1);
    });

    const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
    const invocation = resolveCliArgvInvocation(parseArgv);
    // Register the primary command (builtin or subcli) so help and command parsing
    // are correct even with lazy command registration.
    const { primary } = invocation;
    if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
      const { getProgramContext } = await import("./program/program-context.js");
      const ctx = getProgramContext(program);
      if (ctx) {
        const { registerCoreCliByName } = await import("./program/command-registry.js");
        await registerCoreCliByName(program, ctx, primary, parseArgv);
      }
      const { registerSubCliByName } = await import("./program/register.subclis.js");
      await registerSubCliByName(program, primary);
    }

    const hasBuiltinPrimary =
      primary !== null && program.commands.some((command) => command.name() === primary);
    const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
      argv: parseArgv,
      primary,
      hasBuiltinPrimary,
    });
    if (!shouldSkipPluginRegistration) {
      // Register plugin CLI commands before parsing
      const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
      const config = await registerPluginCliCommandsFromValidatedConfig(
        program,
        undefined,
        undefined,
        {
          mode: "lazy",
          primary,
        },
      );
      if (config) {
        if (primary && !program.commands.some((command) => command.name() === primary)) {
          const missingPluginCommandMessage = await resolveMissingPluginCommandMessage(
            primary,
            config,
          );
          if (missingPluginCommandMessage) {
            throw new Error(missingPluginCommandMessage);
          }
        }
      }
    }

    try {
      await program.parseAsync(parseArgv);
    } catch (error) {
      if (!(error instanceof CommanderError)) {
        throw error;
      }
      process.exitCode = error.exitCode;
    }
  } finally {
    await closeCliMemoryManagers();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
