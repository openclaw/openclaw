import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";
import { loadCliDotEnv } from "./dotenv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { closeAllMemorySearchManagers } = await import("../memory/search-manager.js");
    await closeAllMemorySearchManagers();
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

export async function runCli(argv: string[] = process.argv) {
  let normalizedArgv = normalizeWindowsArgv(argv);
  const parsedProfile = parseCliProfileArgs(normalizedArgv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  normalizedArgv = parsedProfile.argv;

  loadCliDotEnv({ quiet: true });
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  try {
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputRootHelp } = await import("./program/root-help.js");
      outputRootHelp();
      return;
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
        registerPluginCliCommands(program, config);
      }
    }

    await program.parseAsync(parseArgv);
  } finally {
    await closeCliMemoryManagers();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
