import type { PluginRuntime } from "./types.js";
import { createWhatsAppLoginTool } from "../../channels/plugins/agent-tools/whatsapp-login.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../web/auth-store.js";

const sendMessageWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendMessageWhatsApp"] = async (
  ...args
) => {
  const { sendMessageWhatsApp } = await loadWebOutbound();
  return sendMessageWhatsApp(...args);
};

const sendPollWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendPollWhatsApp"] = async (
  ...args
) => {
  const { sendPollWhatsApp } = await loadWebOutbound();
  return sendPollWhatsApp(...args);
};

const loginWebLazy: PluginRuntime["channel"]["whatsapp"]["loginWeb"] = async (...args) => {
  const { loginWeb } = await loadWebLogin();
  return loginWeb(...args);
};

const startWebLoginWithQrLazy: PluginRuntime["channel"]["whatsapp"]["startWebLoginWithQr"] = async (
  ...args
) => {
  const { startWebLoginWithQr } = await loadWebLoginQr();
  return startWebLoginWithQr(...args);
};

const waitForWebLoginLazy: PluginRuntime["channel"]["whatsapp"]["waitForWebLogin"] = async (
  ...args
) => {
  const { waitForWebLogin } = await loadWebLoginQr();
  return waitForWebLogin(...args);
};

const monitorWebChannelLazy: PluginRuntime["channel"]["whatsapp"]["monitorWebChannel"] = async (
  ...args
) => {
  const { monitorWebChannel } = await loadWebChannel();
  return monitorWebChannel(...args);
};

const handleWhatsAppActionLazy: PluginRuntime["channel"]["whatsapp"]["handleWhatsAppAction"] =
  async (...args) => {
    const { handleWhatsAppAction } = await loadWhatsAppActions();
    return handleWhatsAppAction(...args);
  };

let webLoginQrPromise: Promise<typeof import("../../web/login-qr.js")> | null = null;
let webChannelPromise: Promise<typeof import("../../channels/web/index.js")> | null = null;
let webOutboundPromise: Promise<typeof import("./runtime-whatsapp-outbound.runtime.js")> | null =
  null;
let webLoginPromise: Promise<typeof import("./runtime-whatsapp-login.runtime.js")> | null = null;
let whatsappActionsPromise: Promise<
  typeof import("../../agents/tools/whatsapp-actions.js")
> | null = null;

function loadWebOutbound() {
  webOutboundPromise ??= import("./runtime-whatsapp-outbound.runtime.js");
  return webOutboundPromise;
}

function loadWebLogin() {
  webLoginPromise ??= import("./runtime-whatsapp-login.runtime.js");
  return webLoginPromise;
}

function loadWebLoginQr() {
  webLoginQrPromise ??= import("../../web/login-qr.js");
  return webLoginQrPromise;
}

function loadWebChannel() {
  webChannelPromise ??= import("../../channels/web/index.js");
  return webChannelPromise;
}

function loadWhatsAppActions() {
  whatsappActionsPromise ??= import("../../agents/tools/whatsapp-actions.js");
  return whatsappActionsPromise;
}

export function createRuntimeWhatsApp(): PluginRuntime["channel"]["whatsapp"] {
  return {
    getActiveWebListener,
    getWebAuthAgeMs,
    logoutWeb,
    logWebSelfId,
    readWebSelfId,
    webAuthExists,
    sendMessageWhatsApp: sendMessageWhatsAppLazy,
    sendPollWhatsApp: sendPollWhatsAppLazy,
    loginWeb: loginWebLazy,
    startWebLoginWithQr: startWebLoginWithQrLazy,
    waitForWebLogin: waitForWebLoginLazy,
    monitorWebChannel: monitorWebChannelLazy,
    handleWhatsAppAction: handleWhatsAppActionLazy,
    createLoginTool: createWhatsAppLoginTool,
  };
}
