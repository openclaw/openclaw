import { formatCliCommand } from "../cli/command-format.js";
import type { UnpairedResponseMode } from "../config/types.channels.js";
import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { channel, idLine, code } = params;
  return [
    "OpenClaw: access not configured.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to approve with:",
    formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
  ].join("\n");
}

/**
 * Build response for unpaired users based on the configured mode.
 * @param mode - Response mode: "silent" (no response), "code-only", or "branded"
 * @returns The response text, or null if mode is "silent"
 */
export function buildUnpairedResponse(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  mode: UnpairedResponseMode;
}): string | null {
  const { channel, idLine, code, mode } = params;

  switch (mode) {
    case "silent":
      return null;
    case "code-only":
      return `Pairing code: ${code}`;
    case "branded":
      return buildPairingReply({ channel, idLine, code });
    default:
      // Default to silent for safety
      return null;
  }
}
