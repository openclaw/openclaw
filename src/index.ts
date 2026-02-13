#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getReplyFromConfig } from "./auto-reply/reply.js";
import { applyTemplate } from "./auto-reply/templating.js";
import { monitorWebChannel } from "./channel-web.js";
import { createDefaultDeps } from "./cli/deps.js";
import { promptYesNo } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import {
  deriveSessionKey,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  resolveMainSessionKeyFromConfig,
  saveSessionStore,
} from "./config/sessions.js";
import { ensureBinary } from "./infra/binaries.js";
import { isCiaoMdnsServerClosedError } from "./infra/bonjour-uncaught.js";
import { loadDotEnv } from "./infra/dotenv.js";
import { normalizeEnv } from "./infra/env.js";
import { formatUncaughtError } from "./infra/errors.js";
import { recordGatewayCrashSync } from "./infra/gateway-incidents.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawCliOnPath } from "./infra/path-env.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import {
  formatDoctorNonInteractiveHint,
  writeRestartSentinelSync,
} from "./infra/restart-sentinel.js";
import { assertSupportedRuntime } from "./infra/runtime-guard.js";
import { isShutdownInProgress } from "./infra/shutdown-state.js";
import { installUnhandledRejectionHandler } from "./infra/unhandled-rejections.js";
import { enableConsoleCapture } from "./logging.js";
import { runCommandWithTimeout, runExec } from "./process/exec.js";
import { assertWebChannel, normalizeE164, toWhatsappJid } from "./utils.js";

loadDotEnv({ quiet: true });
normalizeEnv();
ensureOpenClawCliOnPath();

// Capture all console output into structured logs while keeping stdout/stderr behavior.
enableConsoleCapture();

// Enforce the minimum supported runtime before doing any work.
assertSupportedRuntime();

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

export {
  assertWebChannel,
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
  toWhatsappJid,
  waitForever,
};

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

if (isMain) {
  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    const isGateway =
      process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
      process.argv.includes("gateway") ||
      process.argv.includes("daemon");

    // @homebridge/ciao occasionally throws ERR_SERVER_CLOSED from a timer callback during
    // shutdown/teardown (send-after-close). This is non-fatal for OpenClaw; suppress it
    // to avoid crash/restart loops.
    if (isCiaoMdnsServerClosedError(error)) {
      if (isGateway) {
        recordGatewayCrashSync({ error, exitCode: null });
      }
      const suffix = isShutdownInProgress() ? " (during shutdown)" : "";
      console.warn(
        `[openclaw] Suppressed ERR_SERVER_CLOSED from ciao${suffix}:`,
        formatUncaughtError(error),
      );
      return;
    }

    if (isGateway) {
      recordGatewayCrashSync({ error, exitCode: 1 });
      const sessionKey = resolveMainSessionKeyFromConfig();
      writeRestartSentinelSync({
        kind: "crash",
        status: "error",
        ts: Date.now(),
        sessionKey,
        message: `Uncaught exception: ${formatUncaughtError(error)}`,
        doctorHint: formatDoctorNonInteractiveHint(),
      });
    }

    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  void program.parseAsync(process.argv).catch((err) => {
    console.error("[openclaw] CLI failed:", formatUncaughtError(err));
    process.exit(1);
  });
}
