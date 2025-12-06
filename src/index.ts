#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { getReplyFromConfig } from "./auto-reply/reply.js";
import { applyTemplate } from "./auto-reply/templating.js";
import { createDefaultDeps } from "./cli/deps.js";
import { promptYesNo } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import {
  deriveSessionKey,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
} from "./config/sessions.js";
import { ensureBinary } from "./infra/binaries.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import { enableConsoleCapture } from "./logging.js";
import { runCommandWithTimeout, runExec } from "./process/exec.js";
import { monitorWebProvider } from "./provider-web.js";
import { assertProvider, normalizeE164, toWhatsappJid } from "./utils.js";

dotenv.config({ quiet: true });

// Capture all console output into pino logs while keeping stdout/stderr behavior.
enableConsoleCapture();

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

export {
  assertProvider,
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
  monitorWebProvider,
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

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  process.on("unhandledRejection", (reason, _promise) => {
    console.error(
      "[clawdis] Unhandled promise rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error(
      "[clawdis] Uncaught exception:",
      error.stack ?? error.message,
    );
    process.exit(1);
  });

  program.parseAsync(process.argv);
}
