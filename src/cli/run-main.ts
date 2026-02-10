import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../infra/is-main.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { tryRouteCli } from "./route.js";

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

export async function runCli(argv: string[] = process.argv) {
  const normalizedArgv = stripWindowsNodeExec(argv);

  // Fast path for --version: resolve version without loading any command modules.
  const isVersionOnly =
    normalizedArgv.includes("--version") ||
    normalizedArgv.includes("-V") ||
    normalizedArgv.includes("-v");
  const isHelpFlag =
    normalizedArgv.includes("--help") || normalizedArgv.includes("-h");
  if (isVersionOnly && !isHelpFlag) {
    const { VERSION } = await import("../version.js");
    console.log(VERSION);
    process.exit(0);
  }

  // Defer heavy env setup (dotenv, normalizeEnv, ensureOpenClawCliOnPath) for
  // help-only invocations — they pull logging/subsystem → channels/registry →
  // plugins/runtime which adds hundreds of ms for no benefit when showing help.
  const isHelpOnly = isHelpFlag && !isVersionOnly;
  if (!isHelpOnly) {
    const { loadDotEnv } = await import("../infra/dotenv.js");
    loadDotEnv({ quiet: true });
    const { normalizeEnv } = await import("../infra/env.js");
    normalizeEnv();
    const { ensureOpenClawCliOnPath } = await import("../infra/path-env.js");
    ensureOpenClawCliOnPath();
    assertSupportedRuntime();
  }

  if (await tryRouteCli(normalizedArgv)) {
    return;
  }

  const primary = getPrimaryCommand(normalizedArgv);

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  const { enableConsoleCapture } = await import("../logging.js");
  enableConsoleCapture();

  // For any --help invocation, use a lightweight program that stubs out
  // message/browser registrations (each loads 10+ sub-modules: ~2s).
  const buildFn = isHelpOnly ? "buildMinimalHelpProgram" : "buildProgram";
  const mod = await import("./program.js");
  const program = await mod[buildFn]();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  const { installUnhandledRejectionHandler } = await import(
    "../infra/unhandled-rejections.js"
  );
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    import("../infra/errors.js").then(({ formatUncaughtError }) => {
      console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    }).catch(() => {
      console.error("[openclaw] Uncaught exception:", error);
    }).finally(() => {
      process.exit(1);
    });
  });

  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Register the primary subcommand if one exists (for lazy-loading)
  if (primary) {
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  const shouldSkipPluginRegistration = !primary && hasHelpOrVersion(parseArgv);
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
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
