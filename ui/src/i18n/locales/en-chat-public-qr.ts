import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatPublicQr = {
  chat: {
    publicQr: {
      label: "QR code for the public link",
      scan: "Scan to open the public link on another device.",
      claw: "Use claw QR",
      standard: "Use standard QR",
      clawLabel: "Claw QR code for the public link",
      downloadClaw: "Download claw QR",
      loadingClaw: "Generating claw QR…",
      clawUnavailable: "Claw artwork unavailable. The standard QR still works.",
    },
  },
} satisfies TranslationMap;

export const registerChatPublicQrEnglish = Object.assign(
  () => Object.assign(en.chat, enChatPublicQr.chat),
  { catalog: enChatPublicQr },
);
