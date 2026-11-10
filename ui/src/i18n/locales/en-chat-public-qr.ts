import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatPublicQr = {
  chat: {
    publicQr: {
      label: "QR code for the public link",
      scan: "Scan to open the public link on another device.",
      lobster: "Use lobster QR",
      standard: "Use standard QR",
      lobsterLabel: "Lobster QR code for the public link",
      download: "Download lobster QR",
      loading: "Generating lobster QR…",
      unavailable: "Lobster artwork unavailable. The standard QR still works.",
    },
  },
} satisfies TranslationMap;

export const registerChatPublicQrEnglish = Object.assign(
  () => Object.assign(en.chat, enChatPublicQr.chat),
  { catalog: enChatPublicQr },
);
