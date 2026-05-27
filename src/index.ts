#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatCliFailureLines } from "./cli/failure-output.js";
import { formatUncaughtError } from "./infra/errors.js";
import { runFatalErrorHooks } from "./infra/fatal-error-hooks.js";
import { isMainModule } from "./infra/is-main.js";
import {
  installUnhandledRejectionHandler,
  isBenignUncaughtExceptionError,
  isUncaughtExceptionHandled,
} from "./infra/unhandled-rejections.js";

type LegacyCliDeps = {
  runCli: (argv: string[]) => Promise<void>;
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
export let loadSessionStore: LibraryExports["loadSessionStore"];
export let monitorWebChannel: LibraryExports["monitorWebChannel"];
export let normalizeE164: LibraryExports["normalizeE164"];
export let PortInUseError: LibraryExports["PortInUseError"];
export let promptYesNo: LibraryExports["promptYesNo"];
export let resolveSessionKey: LibraryExports["resolveSessionKey"];
export let resolveStorePath: LibraryExports["resolveStorePath"];
export let runCommandWithTimeout: LibraryExports["runCommandWithTimeout"];
export let runExec: LibraryExports["runExec"];
export let saveSessionStore: LibraryExports["saveSessionStore"];
export let waitForever: LibraryExports["waitForever"];

async function loadLegacyCliDeps(): Promise<LegacyCliDeps> {
  const { runCli } = await import("./cli/run-main.js");
  return { runCli };
}

// Legacy direct file entrypoint only. Package root exports now live in library.ts.
export async function runLegacyCliEntry(
  argv: string[] = process.argv,
  deps?: LegacyCliDeps,
): Promise<void> {
  const { runCli } = deps ?? (await loadLegacyCliDeps());
  await runCli(argv);
}

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

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
    loadSessionStore,
    monitorWebChannel,
    normalizeE164,
    PortInUseError,
    promptYesNo,
    resolveSessionKey,
    resolveStorePath,
    runCommandWithTimeout,
    runExec,
    saveSessionStore,
    waitForever,
  } = await import("./library.js"));
}

if (isMain) {
  const { restoreTerminalState } = await import("./terminal/restore.js");

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
    restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
    process.exit(1);
  });

  // Wall-clock safety net for `agent --local`: arm a hard timeout before
  // CLI entry so hung commands don't live forever. Synchronous argv parsing
  // only — no async, no config import (breaks subshell contexts).
  (() => {
    const a = process.argv;
    let sub: string | undefined;
    for (let i = 2; i < a.length; i++) {
      const v = a[i];
      if (!v) continue;
      if (v === "--") break;
      if (!v.startsWith("-")) { sub = v; break; }
    }
    if (sub !== "agent") return;
    let hasLocal = false;
    let s: string | undefined;
    for (let i = 2; i < a.length; i++) {
      const v = a[i];
      if (!v) continue;
      if (v === "--") break;
      if (v === "-h" || v === "--help" || v === "--version" || v === "-V") return;
      if (v === "--local" || v.startsWith("--local=")) hasLocal = true;
      if (v === "--timeout") s = a[i + 1];
      else if (v.startsWith("--timeout=")) s = v.slice(10);
    }
    if (!hasLocal) return;
    let n = 600;
    if (s !== undefined) { const p = parseInt(s, 10); if (Number.isFinite(p) && p >= 0) n = p; }
    if (n === 0) return;
    const t = setTimeout(() => {
      try { process.stderr.write(`local agent command timed out after ${n}s plus 30s grace\n`); } catch {}
      try { process.exit(124); } catch {}
    }, (n + 30) * 1000);
    t.unref();
  })();

  void runLegacyCliEntry(process.argv).then(() => {
    // Work is done — force exit. Background handles (LCM compaction, otel
    // exporter, plugin loops) can keep the event loop alive indefinitely.
    setTimeout(() => { try { process.kill(process.pid, "SIGKILL"); } catch {} }, 3000);
    process.exit(process.exitCode ?? 0);
  }).catch((err) => {
    for (const line of formatCliFailureLines({
      title: "The CLI command failed.",
      error: err,
      argv: process.argv,
    })) {
      console.error(line);
    }
    for (const message of runFatalErrorHooks({ reason: "legacy_cli_failure", error: err })) {
      console.error("[openclaw]", message);
    }
    restoreTerminalState("legacy cli failure", { resumeStdinIfPaused: false });
    process.exit(1);
  });
}
