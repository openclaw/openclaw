import type { PairingChannel } from "./pairing-store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { t } from "../i18n/index.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { channel, idLine, code } = params;
  return [
    t("pairing.access_not_configured"),
    "",
    idLine,
    "",
    t("pairing.pairing_code", { code }),
    "",
    t("pairing.ask_owner_approve"),
    formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
  ].join("\n");
}
