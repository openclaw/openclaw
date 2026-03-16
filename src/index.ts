#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatUncaughtError } from "./infra/errors.js";
import { isMainModule } from "./infra/is-main.js";
import { installUnhandledRejectionHandler } from "./infra/unhandled-rejections.js";

const library = await import("./library.js");

export const assertWebChannel = library.assertWebChannel;
export const applyTemplate = library.applyTemplate;
export const createDefaultDeps = library.createDefaultDeps;
export const deriveSessionKey = library.deriveSessionKey;
export const describePortOwner = library.describePortOwner;
export const ensureBinary = library.ensureBinary;
export const ensurePortAvailable = library.ensurePortAvailable;
export const getReplyFromConfig = library.getReplyFromConfig;
export const handlePortError = library.handlePortError;
export const loadConfig = library.loadConfig;
export const loadSessionStore = library.loadSessionStore;
export const monitorWebChannel = library.monitorWebChannel;
export const normalizeE164 = library.normalizeE164;
export const PortInUseError = library.PortInUseError;
export const promptYesNo = library.promptYesNo;
export const resolveSessionKey = library.resolveSessionKey;
export const resolveStorePath = library.resolveStorePath;
export const runCommandWithTimeout = library.runCommandWithTimeout;
export const runExec = library.runExec;
export const saveSessionStore = library.saveSessionStore;
export const toWhatsappJid = library.toWhatsappJid;
export const waitForever = library.waitForever;

// Legacy direct file entrypoint only. Package root exports now live in library.ts.
export async function runLegacyCliEntry(argv: string[] = process.argv): Promise<void> {
  const [{ installGaxiosFetchCompat }, { runCli }] = await Promise.all([
    import("./infra/gaxios-fetch-compat.js"),
    import("./cli/run-main.js"),
  ]);

  installGaxiosFetchCompat();
  await runCli(argv);
}

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

if (isMain) {
  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  void runLegacyCliEntry(process.argv).catch((err) => {
    console.error("[openclaw] CLI failed:", formatUncaughtError(err));
    process.exit(1);
  });
}
