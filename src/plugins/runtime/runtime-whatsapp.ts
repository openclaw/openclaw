import { getActiveWebListener } from "../../../extensions/whatsapp/src/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../../extensions/whatsapp/src/auth-store.js";
import { createRuntimeWhatsAppLoginTool } from "./runtime-whatsapp-login-tool.js";
import type { PluginRuntime } from "./types.js";

type RuntimeWhatsAppOutbound =
  typeof import("./runtime-whatsapp-outbound.runtime.js").runtimeWhatsAppOutbound;
type RuntimeWhatsAppLogin =
  typeof import("./runtime-whatsapp-login.runtime.js").runtimeWhatsAppLogin;

const sendMessageWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendMessageWhatsApp"] = async (
  ...args
) => {
  const runtimeWhatsAppOutbound = await loadWebOutbound();
  return runtimeWhatsAppOutbound.sendMessageWhatsApp(...args);
};

const sendPollWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendPollWhatsApp"] = async (
  ...args
) => {
  const runtimeWhatsAppOutbound = await loadWebOutbound();
  return runtimeWhatsAppOutbound.sendPollWhatsApp(...args);
};

const loginWebLazy: PluginRuntime["channel"]["whatsapp"]["loginWeb"] = async (...args) => {
  const runtimeWhatsAppLogin = await loadWebLogin();
  return runtimeWhatsAppLogin.loginWeb(...args);
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

let webLoginQrPromise: Promise<
  typeof import("../../../extensions/whatsapp/src/login-qr.js")
> | null = null;
let webChannelPromise: Promise<typeof import("../../channels/web/index.js")> | null = null;
let webOutboundPromise: Promise<RuntimeWhatsAppOutbound> | null = null;
let webLoginPromise: Promise<RuntimeWhatsAppLogin> | null = null;
let whatsappActionsPromise: Promise<
  typeof import("../../agents/tools/whatsapp-actions.js")
> | null = null;

function loadWebOutbound() {
  webOutboundPromise ??= import("./runtime-whatsapp-outbound.runtime.js").then(
    ({ runtimeWhatsAppOutbound }) => runtimeWhatsAppOutbound,
  );
  return webOutboundPromise;
}

function loadWebLogin() {
  webLoginPromise ??= import("./runtime-whatsapp-login.runtime.js").then(
    ({ runtimeWhatsAppLogin }) => runtimeWhatsAppLogin,
  );
  return webLoginPromise;
}

function loadWebLoginQr() {
  webLoginQrPromise ??= import("../../../extensions/whatsapp/src/login-qr.js");
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
    createLoginTool: createRuntimeWhatsAppLoginTool,
  };
}
