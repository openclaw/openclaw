import { createWhatsAppLoginTool } from "../../channels/plugins/agent-tools/whatsapp-login.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../web/auth-store.js";
import type { PluginRuntime } from "./types.js";

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

/** Wrap a dynamic import promise so a missing @whiskeysockets/baileys produces a clear error. */
function withBaileysCheck<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    const code = (err as { code?: string }).code;
    const msg = String(err);
    if (
      code === "ERR_MODULE_NOT_FOUND" &&
      (msg.includes("@whiskeysockets/baileys") || msg.includes("libsignal"))
    ) {
      const hint =
        "WhatsApp channel unavailable: @whiskeysockets/baileys requires Git to install " +
        "(it has a GitHub-sourced dependency). Run: npm install @whiskeysockets/baileys (requires Git)";
      console.warn(hint);
      throw Object.assign(new Error(hint), { cause: err });
    }
    throw err;
  });
}

function loadWebOutbound() {
  // Clear on rejection so callers can retry after baileys is installed (no gateway restart needed).
  webOutboundPromise ??= withBaileysCheck(import("./runtime-whatsapp-outbound.runtime.js")).catch(
    (err) => {
      webOutboundPromise = null;
      throw err;
    },
  );
  return webOutboundPromise;
}

function loadWebLogin() {
  webLoginPromise ??= withBaileysCheck(import("./runtime-whatsapp-login.runtime.js")).catch(
    (err) => {
      webLoginPromise = null;
      throw err;
    },
  );
  return webLoginPromise;
}

function loadWebLoginQr() {
  webLoginQrPromise ??= withBaileysCheck(import("../../web/login-qr.js")).catch((err) => {
    webLoginQrPromise = null;
    throw err;
  });
  return webLoginQrPromise;
}

function loadWebChannel() {
  webChannelPromise ??= withBaileysCheck(import("../../channels/web/index.js")).catch((err) => {
    webChannelPromise = null;
    throw err;
  });
  return webChannelPromise;
}

function loadWhatsAppActions() {
  whatsappActionsPromise ??= withBaileysCheck(
    import("../../agents/tools/whatsapp-actions.js"),
  ).catch((err) => {
    whatsappActionsPromise = null;
    throw err;
  });
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
