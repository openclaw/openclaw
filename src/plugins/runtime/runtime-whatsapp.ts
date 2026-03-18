import { getActiveWebListener } from "../../../extensions/whatsapp/runtime-api.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../../extensions/whatsapp/runtime-api.js";
import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { createRuntimeWhatsAppLoginTool } from "./runtime-whatsapp-login-tool.js";
import type { PluginRuntime } from "./types.js";

const loadWebOutbound = createLazyRuntimeSurface(
  () => import("./runtime-whatsapp-outbound.runtime.js"),
  ({ runtimeWhatsAppOutbound }) => runtimeWhatsAppOutbound,
);

const loadWebLogin = createLazyRuntimeSurface(
  () => import("./runtime-whatsapp-login.runtime.js"),
  ({ runtimeWhatsAppLogin }) => runtimeWhatsAppLogin,
);

const bindWhatsAppOutboundMethod = createLazyRuntimeMethodBinder(loadWebOutbound);
const bindWhatsAppLoginMethod = createLazyRuntimeMethodBinder(loadWebLogin);

const sendMessageWhatsAppLazy = bindWhatsAppOutboundMethod(
  (runtimeWhatsAppOutbound) => runtimeWhatsAppOutbound.sendMessageWhatsApp,
);
const sendPollWhatsAppLazy = bindWhatsAppOutboundMethod(
  (runtimeWhatsAppOutbound) => runtimeWhatsAppOutbound.sendPollWhatsApp,
);
const loginWebLazy = bindWhatsAppLoginMethod(
  (runtimeWhatsAppLogin) => runtimeWhatsAppLogin.loginWeb,
);

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
  typeof import("../../../extensions/whatsapp/login-qr-api.js")
> | null = null;
let webChannelPromise: Promise<typeof import("../../channels/web/index.js")> | null = null;
let whatsappActionsPromise: Promise<
  typeof import("../../../extensions/whatsapp/runtime-api.js")
> | null = null;

function loadWebLoginQr() {
  webLoginQrPromise ??= import("../../../extensions/whatsapp/login-qr-api.js");
  return webLoginQrPromise;
}

function loadWebChannel() {
  webChannelPromise ??= import("../../channels/web/index.js");
  return webChannelPromise;
}

function loadWhatsAppActions() {
  whatsappActionsPromise ??= import("../../../extensions/whatsapp/runtime-api.js");
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
