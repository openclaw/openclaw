#!/usr/bin/env node
import { spawn } from "node:child_process";
import { enableCompileCache } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  getCommandPathWithRootOptions,
  getPositiveIntFlagValue,
  hasFlag,
  hasHelpOrVersion,
  isRootHelpInvocation,
  isRootVersionInvocation,
} from "./cli/argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { buildCliRespawnPlan } from "./entry.respawn.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";
import type { RuntimeEnv } from "./runtime.js";

const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  // Imported as a dependency — skip all entry-point side effects.
} else {
  const { installGaxiosFetchCompat } = await import("./infra/gaxios-fetch-compat.js");

  await installGaxiosFetchCompat();
  process.title = "openclaw";
  ensureOpenClawExecMarkerOnProcess();
  installProcessWarningFilter();
  normalizeEnv();
  if (!isTruthyEnvValue(process.env.NODE_DISABLE_COMPILE_CACHE)) {
    try {
      enableCompileCache();
    } catch {
      // Best-effort only; never block startup.
    }
  }

  if (shouldForceReadOnlyAuthStore(process.argv)) {
    process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
  }

  if (process.argv.includes("--no-color")) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }

  function ensureCliRespawnReady(): boolean {
    const plan = buildCliRespawnPlan();
    if (!plan) {
      return false;
    }

    const child = spawn(process.execPath, plan.argv, {
      stdio: "inherit",
      env: plan.env,
    });

    attachChildProcessBridge(child);

    child.once("exit", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        return;
      }
      process.exit(code ?? 1);
    });

    child.once("error", (error) => {
      console.error(
        "[openclaw] Failed to respawn CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exit(1);
    });

    // Parent must not continue running the CLI.
    return true;
  }

  function tryHandleRootVersionFastPath(argv: string[]): boolean {
    if (!isRootVersionInvocation(argv)) {
      return false;
    }
    Promise.all([import("./version.js"), import("./infra/git-commit.js")])
      .then(([{ VERSION }, { resolveCommitHash }]) => {
        const commit = resolveCommitHash({ moduleUrl: import.meta.url });
        console.log(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
        process.exit(0);
      })
      .catch((error) => {
        console.error(
          "[openclaw] Failed to resolve version:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exitCode = 1;
      });
    return true;
  }

  process.argv = normalizeWindowsArgv(process.argv);

  if (!ensureCliRespawnReady()) {
    const parsed = parseCliProfileArgs(process.argv);
    if (!parsed.ok) {
      // Keep it simple; Commander will handle rich help/errors after we strip flags.
      console.error(`[openclaw] ${parsed.error}`);
      process.exit(2);
    }

    if (parsed.profile) {
      applyCliProfileEnv({ profile: parsed.profile });
      // Keep Commander and ad-hoc argv checks consistent.
      process.argv = parsed.argv;
    }

    if (!tryHandleRootVersionFastPath(process.argv) && !tryHandleStatusJsonFastPath(process.argv)) {
      runMainOrRootHelp(process.argv);
    }
  }
}

export function tryHandleStatusJsonFastPath(
  argv: string[],
  deps: {
    statusJsonCommand?: (
      opts: {
        deep?: boolean;
        usage?: boolean;
        timeoutMs?: number;
        all?: boolean;
      },
      runtime: RuntimeEnv,
    ) => Promise<void>;
    runtime?: RuntimeEnv;
    onError?: (error: unknown) => void;
  } = {},
): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  if (primary !== "status" || secondary !== undefined || !hasFlag(argv, "--json")) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
  if (timeoutMs === null) {
    return false;
  }
  const opts = {
    deep: hasFlag(argv, "--deep"),
    all: hasFlag(argv, "--all"),
    usage: hasFlag(argv, "--usage"),
    timeoutMs,
  };
  const handleError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to render status JSON:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  const run = async () => {
    try {
      if (deps.statusJsonCommand && deps.runtime) {
        await deps.statusJsonCommand(opts, deps.runtime);
        return;
      }
      const [{ statusJsonCommand }, { defaultRuntime }] = await Promise.all([
        import("./commands/status-json.js"),
        import("./runtime.js"),
      ]);
      await statusJsonCommand(opts, defaultRuntime);
    } finally {
      try {
        const { closeAllMemorySearchManagers } = await import("./memory/search-manager.js");
        await closeAllMemorySearchManagers();
      } catch {
        // Best-effort teardown for short-lived CLI processes.
      }
    }
  };
  void run().catch(handleError);
  return true;
}

export function tryHandleRootHelpFastPath(
  argv: string[],
  deps: {
    outputRootHelp?: () => void;
    onError?: (error: unknown) => void;
  } = {},
): boolean {
  if (!isRootHelpInvocation(argv)) {
    return false;
  }
  const handleError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to display help:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  if (deps.outputRootHelp) {
    try {
      deps.outputRootHelp();
    } catch (error) {
      handleError(error);
    }
    return true;
  }
  import("./cli/program/root-help.js")
    .then(({ outputRootHelp }) => {
      outputRootHelp();
    })
    .catch(handleError);
  return true;
}

function runMainOrRootHelp(argv: string[]): void {
  if (tryHandleRootHelpFastPath(argv)) {
    return;
  }
  import("./cli/run-main.js")
    .then(({ runCli }) => runCli(argv))
    .catch((error) => {
      console.error(
        "[openclaw] Failed to start CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
}
