import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.types.js";

type PairingLocaleStrings = {
  accessNotConfigured: string;
  pairingCode: string;
  askOwnerToApprove: string;
};

const PAIRING_LOCALES: Record<string, PairingLocaleStrings> = {
  en: {
    accessNotConfigured: "OpenClaw: access not configured.",
    pairingCode: "Pairing code:",
    askOwnerToApprove: "Ask the bot owner to approve with:",
  },
  tr: {
    accessNotConfigured: "OpenClaw: erişim yapılandırılmamış.",
    pairingCode: "Eşleşme kodu:",
    askOwnerToApprove: "Bot sahibinden şu komutla onay isteyin:",
  },
};

function resolveLocaleStrings(locale?: string): PairingLocaleStrings {
  if (locale && PAIRING_LOCALES[locale]) {
    return PAIRING_LOCALES[locale];
  }
  return PAIRING_LOCALES.en;
}

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  locale?: string;
}): string {
  const { channel, idLine, code } = params;
  const strings = resolveLocaleStrings(params.locale);
  const approveCommand = formatCliCommand(`openclaw pairing approve ${channel} ${code}`);
  return [
    strings.accessNotConfigured,
    "",
    idLine,
    strings.pairingCode,
    "```",
    code,
    "```",
    "",
    strings.askOwnerToApprove,
    formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
    "```",
    approveCommand,
    "```",
  ].join("\n");
}
