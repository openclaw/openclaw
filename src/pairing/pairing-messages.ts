import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { channel, idLine, code } = params;
  const approveCommand = formatCliCommand(`mullusi pairing approve ${channel} ${code}`);
  return [
    "Mullusi: access not configured.",
    "",
    idLine,
    "Pairing code:",
    "```",
    code,
    "```",
    "",
    "Ask the bot owner to approve with:",
    formatCliCommand(`mullusi pairing approve ${channel} ${code}`),
    "```",
    approveCommand,
    "```",
  ].join("\n");
}
