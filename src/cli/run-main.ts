import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import {
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";

type Awaitable<T> = T | Promise<T>;

function createGatewayCliMainStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: cli.main.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  if (argv[2] !== "gateway") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion || invocation.commandPath[0] !== "gateway") {
    return false;
  }
  return invocation.commandPath.length === 1 || invocation.commandPath[1] === "run";
}

function hasJsonOutputFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}

async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    return false;
  }
  const [
    { Command },
    { addGatewayRunCommand },
    { VERSION },
    { emitCliBanner },
    { resolveCliStartupPolicy },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
    ]),
  );
  const invocation = resolveCliArgvInvocation(argv);
  const startupPolicy = resolveCliStartupPolicy({
    commandPath: invocation.commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
    routeMode: true,
  });
  if (!startupPolicy.hideBanner) {
    emitCliBanner(VERSION, { argv });
  }
  const program = new Command();
  program.name("openclaw");
  program.enablePositionalOptions();
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

async function closeCliMemoryManagers(): Promise<void> {
  const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
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

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  return resolveMissingPluginCommandMessageFromPolicy(
    pluginId,
    config,
    options?.registry ? { registry: options.registry } : undefined,
  );
}

function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

export async function runCli(argv: string[] = process.argv) {
  const originalArgv = normalizeWindowsArgv(argv);
  const startupTrace = createGatewayCliMainStartupTrace(originalArgv);
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
  startupTrace.mark("argv");

  if (shouldLoadCliDotEnv()) {
    await startupTrace.measure("dotenv", async () => {
      const { loadCliDotEnv } = await import("./dotenv.js");
      loadCliDotEnv({ quiet: true });
    });
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

    if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedBrowserHelpText } = await import("./root-help-metadata.js");
      if (outputPrecomputedBrowserHelpText()) {
        return;
      }
    }

    const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);
    const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
    if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) {
      await ensureCliEnvProxyDispatcher();
    }

    if (shouldRunBareRootCrestodian) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          'Crestodian needs an interactive TTY. Use `openclaw crestodian --message "status"` for one command.',
        );
        process.exitCode = 1;
        return;
      }
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      const { createCliProgress } = await import("./progress.js");
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      let progressStopped = false;
      const stopProgress = () => {
        if (progressStopped) {
          return;
        }
        progressStopped = true;
        progress.done();
      };
      try {
        await runCrestodian({ onReady: stopProgress });
      } finally {
        stopProgress();
      }
      return;
    }

    if (shouldRunModernOnboardCrestodian) {
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      const nonInteractive = normalizedArgv.includes("--non-interactive");
      await runCrestodian({
        message: nonInteractive ? "overview" : undefined,
        yes: false,
        json: normalizedArgv.includes("--json"),
        interactive: !nonInteractive,
      });
      return;
    }

    const [
      { initializeDebugProxyCapture, finalizeDebugProxyCapture },
      { maybeWarnAboutDebugProxyCoverage },
    ] = await startupTrace.measure("proxy-imports", () =>
      Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
    );
    initializeDebugProxyCapture("cli");
    process.once("exit", () => {
      finalizeDebugProxyCapture();
    });
    await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
    maybeWarnAboutDebugProxyCoverage();

    if (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace)) {
      return;
    }

    const { tryRouteCli } = await startupTrace.measure("route-import", () => import("./route.js"));
    if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) {
      return;
    }

    const { createCliProgress } = await import("./progress.js");
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      fallback: "none",
    });
    let startupProgressStopped = false;
    const stopStartupProgress = () => {
      if (startupProgressStopped) {
        return;
      }
      startupProgressStopped = true;
      startupProgress.done();
    };

    try {
      // Capture all console output into structured logs while keeping stdout/stderr behavior.
      const { enableConsoleCapture } = await import("../logging.js");
      enableConsoleCapture();

      const [
        { buildProgram },
        { formatUncaughtError },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { restoreTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../terminal/restore.js"),
        ]),
      );
      const program = await startupTrace.measure("build-program", () => buildProgram());

      // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
      // These log the error and exit gracefully instead of crashing without trace.
      installUnhandledRejectionHandler();

      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        if (isBenignUncaughtExceptionError(error)) {
          console.warn(
            "[openclaw] Non-fatal uncaught exception (continuing):",
            formatUncaughtError(error),
          );
          return;
        }
        console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
        for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
          console.error("[openclaw]", message);
        }
        restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
        process.exit(1);
      });

      const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
      const invocation = resolveCliArgvInvocation(parseArgv);
      // Register the primary command (builtin or subcli) so help and command parsing
      // are correct even with lazy command registration.
      const { primary } = invocation;
      if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
        await startupTrace.measure("register-primary", async () => {
          const { getProgramContext } = await import("./program/program-context.js");
          const ctx = getProgramContext(program);
          if (ctx) {
            const { registerCoreCliByName } = await import("./program/command-registry.js");
            await registerCoreCliByName(program, ctx, primary, parseArgv);
          }
          const { registerSubCliByName } = await import("./program/register.subclis.js");
          await registerSubCliByName(program, primary, parseArgv);
        });
      }

      const hasBuiltinPrimary =
        primary !== null &&
        program.commands.some(
          (command) => command.name() === primary || command.aliases().includes(primary),
        );
      const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
        argv: parseArgv,
        primary,
        hasBuiltinPrimary,
      });
      if (!shouldSkipPluginRegistration) {
        const config = await startupTrace.measure("register-plugin-commands", async () => {
          const { registerPluginCliCommandsFromValidatedConfig } =
            await import("../plugins/cli.js");
          return await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            mode: "lazy",
            primary,
          });
        });
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner } =
              await import("../plugins/manifest-command-aliases.runtime.js");
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
              },
            );
            if (missingPluginCommandMessage) {
              throw new Error(missingPluginCommandMessage);
            }
          }
        }
      }

      stopStartupProgress();

      try {
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    await closeCliMemoryManagers();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
