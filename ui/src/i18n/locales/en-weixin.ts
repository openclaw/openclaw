import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  channels: {
    weixin: {
      title: "Personal Weixin",
      description: "Connect your personal Weixin account by scanning a QR code.",
      scan: "Scan with Weixin, then confirm on your phone. The code refreshes automatically when needed.",
      qrAlt: "Weixin login QR code",
      verify: "Verification code",
      expired: "This QR code expired. Reconnect to generate a new code.",
      authenticated: "Login confirmed. Check the channel status above to confirm it is running.",
      enable: "Enable and connect",
      reconnect: "Reconnect",
      savedDescription: "Your login is saved. Scan again only when replacing or renewing it.",
      sessionChanged: "The Weixin login session changed. Please reconnect.",
      pendingMissing: "Weixin did not return a pending login session. Please reconnect.",
      unsupported:
        "This Weixin plugin needs the page-login adapter. Update the plugin before reconnecting.",
      restart: "Weixin is enabled. Restart the Gateway, then return here to connect.",
    },
  },
} satisfies TranslationMap;

export const registerWeixinEnglish = Object.assign(
  () => {
    en.channels = Object.assign({}, en.channels, catalog.channels);
  },
  { catalog },
);
