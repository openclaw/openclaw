import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

function closeLingeringCliTlsSockets(): void {
  const handles = process._getActiveHandles();
  for (const handle of handles) {
    if (!handle || typeof handle !== "object") {
      continue;
    }
    const encrypted = "encrypted" in handle ? handle.encrypted : false;
    if (encrypted !== true) {
      continue;
    }
    const fd = "fd" in handle ? handle.fd : undefined;
    if (fd === 0 || fd === 1 || fd === 2) {
      continue;
    }
    const unref = "unref" in handle ? handle.unref : undefined;
    if (typeof unref === "function") {
      try {
        unref.call(handle);
      } catch {
        // Best-effort only.
      }
    }
    const destroy = "destroy" in handle ? handle.destroy : undefined;
    if (typeof destroy === "function") {
      try {
        destroy.call(handle);
      } catch {
        // Best-effort only.
      }
    }
  }
}

async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { closeAllMemorySearchManagers } = await import("../memory/search-manager.js");
    await closeAllMemorySearchManagers({ fast: true });
  } catch {
    // Best-effort teardown for short-lived CLI processes.
  }
}

async function closeCliNetworkDispatchers(): Promise<void> {
  try {
    if (process.env.OPENCLAW_DEBUG_ACTIVE_HANDLES === "1") {
      console.error("[openclaw][net] closeCliNetworkDispatchers:start");
    }
    const { closeGlobalUndiciDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    await closeGlobalUndiciDispatcher();
    if (process.env.OPENCLAW_DEBUG_ACTIVE_HANDLES === "1") {
      console.error("[openclaw][net] closeCliNetworkDispatchers:end");
    }
  } catch {
    // Best-effort teardown for short-lived CLI processes.
  }
}

function logCliShutdownMarker(label: string): void {
  if (process.env.OPENCLAW_DEBUG_ACTIVE_HANDLES !== "1") {
    return;
  }
  console.error(`[openclaw][shutdown] ${label} ts=${Date.now()}`);
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

  loadDotEnv({ quiet: true });
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
    logCliShutdownMarker("before-closeCliMemoryManagers");
    await closeCliMemoryManagers();
    logCliShutdownMarker("after-closeCliMemoryManagers");
    await closeCliNetworkDispatchers();
    logCliShutdownMarker("after-closeCliNetworkDispatchers");
    closeLingeringCliTlsSockets();
    logCliShutdownMarker("after-closeLingeringCliTlsSockets");
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
