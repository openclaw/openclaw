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

type ReplyRuntimeModule = typeof import("./auto-reply/reply.runtime.js");
type PromptRuntimeModule = typeof import("./cli/prompt.runtime.js");
type BinariesRuntimeModule = typeof import("./infra/binaries.runtime.js");
type ExecRuntimeModule = typeof import("./process/exec.js");
type WhatsAppRuntimeModule = typeof import("./plugins/runtime/runtime-whatsapp-boundary.js");

let replyRuntimePromise: Promise<ReplyRuntimeModule> | undefined;
let promptRuntimePromise: Promise<PromptRuntimeModule> | undefined;
let binariesRuntimePromise: Promise<BinariesRuntimeModule> | undefined;
let execRuntimePromise: Promise<ExecRuntimeModule> | undefined;
let whatsappRuntimePromise: Promise<WhatsAppRuntimeModule> | undefined;

function loadReplyRuntime(): Promise<ReplyRuntimeModule> {
  return (replyRuntimePromise ??= import("./auto-reply/reply.runtime.js"));
}

function loadPromptRuntime(): Promise<PromptRuntimeModule> {
  return (promptRuntimePromise ??= import("./cli/prompt.runtime.js"));
}

function loadBinariesRuntime(): Promise<BinariesRuntimeModule> {
  return (binariesRuntimePromise ??= import("./infra/binaries.runtime.js"));
}

function loadExecRuntime(): Promise<ExecRuntimeModule> {
  return (execRuntimePromise ??= import("./process/exec.js"));
}

function loadWhatsAppRuntime(): Promise<WhatsAppRuntimeModule> {
  return (whatsappRuntimePromise ??= import("./plugins/runtime/runtime-whatsapp-boundary.js"));
}

export const getReplyFromConfig: ReplyRuntimeModule["getReplyFromConfig"] = async (...args) =>
  (await loadReplyRuntime()).getReplyFromConfig(...args);
export const promptYesNo: PromptRuntimeModule["promptYesNo"] = async (...args) =>
  (await loadPromptRuntime()).promptYesNo(...args);
export const ensureBinary: BinariesRuntimeModule["ensureBinary"] = async (...args) =>
  (await loadBinariesRuntime()).ensureBinary(...args);
export const runExec: ExecRuntimeModule["runExec"] = async (...args) =>
  (await loadExecRuntime()).runExec(...args);
export const runCommandWithTimeout: ExecRuntimeModule["runCommandWithTimeout"] = async (
  ...args
) =>
  (await loadExecRuntime()).runCommandWithTimeout(...args);
export const monitorWebChannel: WhatsAppRuntimeModule["monitorWebChannel"] = async (...args) =>
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
