#!/usr/bin/env node
import { existsSync } from "node:fs";
// Re-exports the OpenClaw CLI entry point for package execution.
// Package executable entrypoint that forwards to the CLI bootstrap.
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  enableOpenClawCompileCache,
  resolveOpenClawCompileCacheRespawnEnv,
} from "../node-compile-cache.mjs";
import { resolveCliArgvInvocation } from "./cli/argv-invocation.js";
import { isForegroundGatewayRunArgv } from "./cli/gateway-run-argv.js";
import {
  isForegroundGmailRunArgv,
  shouldKeepNativeHookRelayInProcess,
} from "./cli/respawn-policy.js";
import { tryRunUpdateAdmissionBeforeStartup } from "./cli/run-main-update-admission.js";
import {
  configureGatewayStartupTraceConsoleFormatting,
  createGatewayDispatchStartupTrace,
} from "./cli/startup-trace.js";
import { isMainModule } from "./infra/is-main.js";
import "./shared/detached-async-context.js";

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});
const handledAdmission =
  isMain && (await tryRunUpdateAdmissionBeforeStartup(resolveCliArgvInvocation(process.argv)));
const packageRootUrl = new URL("../", import.meta.url);
if (
  !handledAdmission &&
  !existsSync(new URL("entry.ts", import.meta.url)) &&
  (existsSync(new URL(".openclaw-lifecycle-pending", packageRootUrl)) ||
    existsSync(new URL("dist/openclaw-install-guard", packageRootUrl)))
) {
  const { completePendingPackageLifecycle } = await import("./infra/package-lifecycle.js");
  try {
    await completePendingPackageLifecycle({ packageRoot: fileURLToPath(packageRootUrl) });
  } catch (error) {
    throw new Error(
      `OpenClaw package lifecycle is incomplete. Reinstall with package scripts enabled, then retry. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

type LegacyCliDeps = {
  runCli: (
    argv: string[],
    options?: {
      retainConsoleRoutingUntilProcessExit?: boolean;
    },
  ) => Promise<void>;
};

type LibraryExports = typeof import("./library.js");

// These bindings are populated only for library consumers. The CLI entry stays
// on the lean path and must not read them while running as main.
export let applyTemplate: LibraryExports["applyTemplate"];
export let createDefaultDeps: LibraryExports["createDefaultDeps"];
export let deriveSessionKey: LibraryExports["deriveSessionKey"];
export let describePortOwner: LibraryExports["describePortOwner"];
export let ensureBinary: LibraryExports["ensureBinary"];
export let ensurePortAvailable: LibraryExports["ensurePortAvailable"];
export let getReplyFromConfig: LibraryExports["getReplyFromConfig"];
export let handlePortError: LibraryExports["handlePortError"];
export let loadConfig: LibraryExports["loadConfig"];
export let monitorWebChannel: LibraryExports["monitorWebChannel"];
export let normalizeE164: LibraryExports["normalizeE164"];
export let PortInUseError: LibraryExports["PortInUseError"];
export let promptYesNo: LibraryExports["promptYesNo"];
export let resolveSessionKey: LibraryExports["resolveSessionKey"];
export let resolveStorePath: LibraryExports["resolveStorePath"];
export let runCommandWithTimeout: LibraryExports["runCommandWithTimeout"];
export let runExec: LibraryExports["runExec"];
export let waitForever: LibraryExports["waitForever"];

async function loadLegacyCliDeps(argv: string[]): Promise<LegacyCliDeps> {
  const startupTrace = createGatewayDispatchStartupTrace(argv, "entry");
  await configureGatewayStartupTraceConsoleFormatting(startupTrace);
  const { runCli } = await startupTrace.measure(
    "run-main-import",
    () => import("./cli/run-main.js"),
  );
  return { runCli };
}

// Legacy executable bridge, also exported for callers that retain their own process lifecycle.
export async function runLegacyCliEntry(
  argv: string[] = process.argv,
  deps?: LegacyCliDeps,
  options?: {
    retainConsoleRoutingUntilProcessExit?: boolean;
  },
): Promise<void> {
  const { runCli } = deps ?? (await loadLegacyCliDeps(argv));
  await runCli(argv, options);
}

const handledRootVersion =
  isMain &&
  !handledAdmission &&
  (await import("./entry.version-fast-path.js")).tryHandleRootVersionFastPath(process.argv);
if (!isMain) {
  ({
    applyTemplate,
    createDefaultDeps,
    deriveSessionKey,
    describePortOwner,
    ensureBinary,
    ensurePortAvailable,
    getReplyFromConfig,
    handlePortError,
    loadConfig,
    monitorWebChannel,
    normalizeE164,
    PortInUseError,
    promptYesNo,
    resolveSessionKey,
    resolveStorePath,
    runCommandWithTimeout,
    runExec,
    waitForever,
  } = await import("./library.js"));
}

const shouldRunCli = isMain && !handledRootVersion && !handledAdmission;
const compileCacheRespawnEnv =
  shouldRunCli &&
  !isForegroundGmailRunArgv(process.argv) &&
  !shouldKeepNativeHookRelayInProcess(process.argv, process.platform)
    ? resolveOpenClawCompileCacheRespawnEnv({ installRoot: fileURLToPath(packageRootUrl) })
    : undefined;
if (compileCacheRespawnEnv) {
  const args = [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)];
  // External supervisors require the serving Gateway to retain its listener PID.
  if (process.execve && isForegroundGatewayRunArgv(process.argv)) {
    process.execve(process.execPath, [process.execPath, ...args], compileCacheRespawnEnv);
  }
  const { runRespawnedChild } = await import("../node-runtime-recovery.mjs");
  await runRespawnedChild(process.execPath, args, compileCacheRespawnEnv);
}
if (shouldRunCli && !compileCacheRespawnEnv) {
  enableOpenClawCompileCache({ installRoot: fileURLToPath(packageRootUrl) });
  const [
    { formatCliFailureLines, formatCliJsonFailure, isExpectedCliError },
    { isJsonOutputModeActive },
    { runCliWithExitFinalization },
    { withCliProcessScope },
    { installDistEsmResolveFastPath },
    { formatUncaughtError },
    { runFatalErrorHooks },
    {
      installUnhandledRejectionHandler,
      isBenignUncaughtExceptionError,
      isUncaughtExceptionHandled,
    },
  ] = await Promise.all([
    import("./cli/failure-output.js"),
    import("./cli/json-output-mode.js"),
    import("./cli/one-shot-exit.js"),
    import("./cli/runtime-cleanup-scope.js"),
    import("./entry.esm-resolve-fast-path.js"),
    import("./infra/errors.js"),
    import("./infra/fatal-error-hooks.js"),
    import("./infra/unhandled-rejections.js"),
  ]);
  installDistEsmResolveFastPath(import.meta.url);

  const { defaultRuntime, restoreRuntimeTerminalState } = await import("./runtime.js");
  const { exitAfterSignalExitBarriers } = await import("./cli/signal-exit-barrier.js");

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
    if (isJsonOutputModeActive(process.argv)) {
      defaultRuntime.writeJson(formatCliJsonFailure(error));
    }
    for (const line of formatCliFailureLines({
      title: "OpenClaw hit an unexpected runtime error.",
      error,
      argv: process.argv,
    })) {
      console.error(line);
    }
    for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
      console.error("[openclaw]", message);
    }
    restoreRuntimeTerminalState("uncaught exception", { resumeStdinIfPaused: false });
    exitAfterSignalExitBarriers(1);
  });

  void runCliWithExitFinalization({
    run: () =>
      withCliProcessScope(() =>
        runLegacyCliEntry(process.argv, undefined, {
          // Finalizers and process-exit hooks can still emit diagnostics after runCli settles.
          retainConsoleRoutingUntilProcessExit: true,
        }),
      ),
    onError: (err) => {
      if (isJsonOutputModeActive(process.argv)) {
        defaultRuntime.writeJson(formatCliJsonFailure(err));
      }
      for (const line of formatCliFailureLines({
        title: "The CLI command failed.",
        error: err,
        argv: process.argv,
      })) {
        console.error(line);
      }
      if (!isExpectedCliError(err)) {
        for (const message of runFatalErrorHooks({ reason: "legacy_cli_failure", error: err })) {
          console.error("[openclaw]", message);
        }
      }
      restoreRuntimeTerminalState("legacy cli failure", { resumeStdinIfPaused: false });
      process.exitCode = 1;
    },
  });
}
