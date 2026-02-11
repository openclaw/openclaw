import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { getCommandPath, getPrimaryCommand, hasHelpOrVersion } from "./argv.js";

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
  const [primary, secondary] = getCommandPath(argv, 2);
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

export async function runCli(argv: string[] = process.argv) {
  const normalizedArgv = stripWindowsNodeExec(argv);
  if (!hasHelpOrVersion(normalizedArgv)) {
    const { loadDotEnv } = await import("../infra/dotenv.js");
    loadDotEnv({ quiet: true });
    // Normalize ZAI env alias (inlined to avoid importing env.ts which pulls in tslog)
    if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
      process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
    }
  }
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  if (!hasHelpOrVersion(normalizedArgv)) {
    const { tryRouteCli } = await import("./route.js");
    if (await tryRouteCli(normalizedArgv)) {
      return;
    }
  }

  const { buildProgramShell } = await import("./program/build-program-shell.js");
  const { program, ctx, provideChannelOptions } = buildProgramShell();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Try to register only the specific command needed instead of all 11 groups.
  // Falls back to full registration for unknown commands or bare `openclaw --help`.
  const primary = getPrimaryCommand(parseArgv);

  let commandRegistered = false;
  if (primary && primary !== "help" && shouldRegisterPrimarySubcommand(parseArgv)) {
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    commandRegistered = await registerSubCliByName(program, primary);

    if (!commandRegistered) {
      const { registerCoreCommandByName } = await import("./program/register.core-lazy.js");
      commandRegistered = await registerCoreCommandByName(program, ctx, primary, parseArgv);
    }
  }

  if (!commandRegistered) {
    const { resolveCliChannelOptions } = await import("./channel-options.js");
    provideChannelOptions(resolveCliChannelOptions);
    const { registerProgramCommands } = await import("./program/command-registry.js");
    await registerProgramCommands(program, ctx, parseArgv);
  }

  const shouldSkipPluginRegistration =
    primary === "help" ||
    shouldSkipPluginCommandRegistration({
      argv: parseArgv,
      primary,
      hasBuiltinPrimary: commandRegistered,
    });
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
  }

  if (!hasHelpOrVersion(parseArgv) && primary !== "help") {
    const { enableConsoleCapture } = await import("../logging.js");
    enableConsoleCapture();
  }

  await program.parseAsync(parseArgv);
}

function stripWindowsNodeExec(argv: string[]): string[] {
  if (process.platform !== "win32") {
    return argv;
  }
  const stripControlChars = (value: string): string => {
    let out = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };
  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")
      .trim();
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");
  const execPath = normalizeCandidate(process.execPath);
  const execPathLower = execPath.toLowerCase();
  const execBase = path.basename(execPath).toLowerCase();
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    return (
      lower === execPathLower ||
      path.basename(lower) === execBase ||
      lower.endsWith("\\node.exe") ||
      lower.endsWith("/node.exe") ||
      lower.includes("node.exe") ||
      (path.basename(lower) === "node.exe" && fs.existsSync(normalized))
    );
  };
  const filtered = argv.filter((arg, index) => index === 0 || !isExecPath(arg));
  if (filtered.length < 3) {
    return filtered;
  }
  const cleaned = [...filtered];
  if (isExecPath(cleaned[1])) {
    cleaned.splice(1, 1);
  }
  if (isExecPath(cleaned[2])) {
    cleaned.splice(2, 1);
  }
  return cleaned;
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
