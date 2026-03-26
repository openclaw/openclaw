import { applyTemplate } from "./auto-reply/templating.js";
import { createDefaultDeps } from "./cli/deps.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import { resolveStorePath } from "./config/sessions/paths.js";
import { deriveSessionKey, resolveSessionKey } from "./config/sessions/session-key.js";
import { loadSessionStore, saveSessionStore } from "./config/sessions/store.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import { assertWebChannel, normalizeE164, toWhatsappJid } from "./utils.js";

type GetReplyFromConfig = typeof import("./auto-reply/reply.runtime.js").getReplyFromConfig;
type PromptYesNo = typeof import("./cli/prompt.js").promptYesNo;
type EnsureBinary = typeof import("./infra/binaries.js").ensureBinary;
type RunExec = typeof import("./process/exec.js").runExec;
type RunCommandWithTimeout = typeof import("./process/exec.js").runCommandWithTimeout;
type MonitorWebChannel =
  typeof import("./plugins/runtime/runtime-whatsapp-boundary.js").monitorWebChannel;

let replyRuntimePromise: Promise<typeof import("./auto-reply/reply.runtime.js")> | null = null;
let promptRuntimePromise: Promise<typeof import("./cli/prompt.js")> | null = null;
let binariesRuntimePromise: Promise<typeof import("./infra/binaries.js")> | null = null;
let execRuntimePromise: Promise<typeof import("./process/exec.js")> | null = null;
let whatsappRuntimePromise: Promise<
  typeof import("./plugins/runtime/runtime-whatsapp-boundary.js")
> | null = null;

function loadReplyRuntime() {
  replyRuntimePromise ??= import("./auto-reply/reply.runtime.js");
  return replyRuntimePromise;
}

function loadPromptRuntime() {
  promptRuntimePromise ??= import("./cli/prompt.js");
  return promptRuntimePromise;
}

function loadBinariesRuntime() {
  binariesRuntimePromise ??= import("./infra/binaries.js");
  return binariesRuntimePromise;
}

function loadExecRuntime() {
  execRuntimePromise ??= import("./process/exec.js");
  return execRuntimePromise;
}

function loadWhatsAppRuntime() {
  whatsappRuntimePromise ??= import("./plugins/runtime/runtime-whatsapp-boundary.js");
  return whatsappRuntimePromise;
}

export const getReplyFromConfig: GetReplyFromConfig = async (...args) =>
  (await loadReplyRuntime()).getReplyFromConfig(...args);
export const promptYesNo: PromptYesNo = async (...args) =>
  (await loadPromptRuntime()).promptYesNo(...args);
export const ensureBinary: EnsureBinary = async (...args) =>
  (await loadBinariesRuntime()).ensureBinary(...args);
export const runExec: RunExec = async (...args) => (await loadExecRuntime()).runExec(...args);
export const runCommandWithTimeout: RunCommandWithTimeout = async (...args) =>
  (await loadExecRuntime()).runCommandWithTimeout(...args);
export const monitorWebChannel: MonitorWebChannel = async (...args) =>
  (await loadWhatsAppRuntime()).monitorWebChannel(...args);

export {
  assertWebChannel,
  applyTemplate,
  createDefaultDeps,
  deriveSessionKey,
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  loadConfig,
  loadSessionStore,
  normalizeE164,
  PortInUseError,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
  toWhatsappJid,
  waitForever,
};
