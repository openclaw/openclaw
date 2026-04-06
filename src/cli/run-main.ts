import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";
import { hasMemoryRuntime } from "../plugins/memory-state.js";
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";
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

export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  if (!primary) {
    return true;
  }
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

export function shouldUseRootHelpFastPath(argv: string[]): boolean {
  return isRootHelpInvocation(argv);
}

export function shouldUseSubcommandHelpFastPath(argv: string[]): boolean {
  return hasHelpOrVersion(argv) && !isRootHelpInvocation(argv) && Boolean(getPrimaryCommand(argv));
}

async function createMinimalHelpProgram() {
  const program = new Command();
  program.enablePositionalOptions();
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });

  const [{ createProgramContext }, { configureProgramHelp }, { setProgramContext }] =
    await Promise.all([
      import("./program/context.js"),
      import("./program/help.js"),
      import("./program/program-context.js"),
    ]);
  const ctx = createProgramContext();
  setProgramContext(program, ctx);
  configureProgramHelp(program, ctx);

  return { program, ctx };
}

const HELP_FAST_PATH_PLUGIN_IDS_BY_PRIMARY: Record<string, readonly string[]> = {
  memory: ["memory-core"],
};

export async function outputSubcommandHelpFastPath(argv: string[]): Promise<boolean> {
  const parseArgv = rewriteUpdateFlagArgv(argv);
  const primary = getPrimaryCommand(parseArgv);
  if (!primary) {
    return false;
  }

  const [{ getCoreCliCommandDescriptors }, { getSubCliEntries }] = await Promise.all([
    import("./program/core-command-descriptors.js"),
    import("./program/subcli-descriptors.js"),
  ]);
  const builtinCommands = new Set([
    ...getCoreCliCommandDescriptors().map((entry) => entry.name),
    ...getSubCliEntries().map((entry) => entry.name),
  ]);
  if (!builtinCommands.has(primary)) {
    return false;
  }

  const { program, ctx } = await createMinimalHelpProgram();
  const { registerCoreCliByName } = await import("./program/command-registry.js");
  await registerCoreCliByName(program, ctx, primary, parseArgv);
  const { registerSubCliByName } = await import("./program/register.subclis.js");
  await registerSubCliByName(program, primary);

  try {
    await program.parseAsync(parseArgv);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

export async function outputPluginSubcommandHelpFastPath(argv: string[]): Promise<boolean> {
  const parseArgv = rewriteUpdateFlagArgv(argv);
  const primary = getPrimaryCommand(parseArgv);
  if (!primary) {
    return false;
  }

  const { program } = await createMinimalHelpProgram();
  const { loadValidatedConfigForPluginRegistration } = await import("./program/register.subclis.js");
  const config = await loadValidatedConfigForPluginRegistration();
  if (!config) {
    return false;
  }

  const { registerPluginCliCommands } = await import("../plugins/cli.js");
  const onlyPluginIds = HELP_FAST_PATH_PLUGIN_IDS_BY_PRIMARY[primary];
  await registerPluginCliCommands(
    program,
    config,
    undefined,
    onlyPluginIds ? { onlyPluginIds: [...onlyPluginIds] } : undefined,
    {
      helpOnly: true,
      primary,
      mode: "eager",
    },
  );
  if (!program.commands.some((command) => command.name() === primary)) {
    return false;
  }

  try {
    await program.parseAsync(parseArgv);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
): string | null {
  const normalizedPluginId = pluginId.trim().toLowerCase();
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().toLowerCase())
      : [];
  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
      `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    );
  }
  if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
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
    parsedContainer.container ?? process.env.OPENCLAW_CONTAINER?.trim() ?? null;
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

    if (shouldUseSubcommandHelpFastPath(normalizedArgv)) {
      if (await outputSubcommandHelpFastPath(normalizedArgv)) {
        return;
      }
      if (await outputPluginSubcommandHelpFastPath(normalizedArgv)) {
        return;
      }
    }

    if (await tryRouteCli(normalizedArgv)) {
      return;
    }

    // Capture all console output into structured logs while keeping stdout/stderr behavior.
    enableConsoleCapture();

    const { buildProgram } = await import("./program.js");
    const program = buildProgram();
    const { installUnhandledRejectionHandler } = await import("../infra/unhandled-rejections.js");

    // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
    // These log the error and exit gracefully instead of crashing without trace.
    installUnhandledRejectionHandler();

    process.on("uncaughtException", (error) => {
      console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
      process.exit(1);
    });

    const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
    // Register the primary command (builtin or subcli) so help and command parsing
    // are correct even with lazy command registration.
    const primary = getPrimaryCommand(parseArgv);
    if (primary) {
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
      const { registerPluginCliCommands } = await import("../plugins/cli.js");
      const { loadValidatedConfigForPluginRegistration } =
        await import("./program/register.subclis.js");
      const config = await loadValidatedConfigForPluginRegistration();
      if (config) {
        await registerPluginCliCommands(program, config, undefined, undefined, {
          helpOnly: hasHelpOrVersion(parseArgv),
          mode: "lazy",
          primary,
        });
        if (primary && !program.commands.some((command) => command.name() === primary)) {
          const missingPluginCommandMessage = resolveMissingPluginCommandMessage(primary, config);
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
