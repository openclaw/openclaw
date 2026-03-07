import { formatCliCommand } from "../cli/command-format.js";
import type { UnpairedResponseMode } from "../config/types.base.js";
import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  mode?: UnpairedResponseMode;
}): string | null {
  const { channel, idLine, code, mode = "branded" } = params;
  if (mode === "silent") {
    return null;
  }
  const lines =
    mode === "code-only"
      ? [
          idLine,
          "",
          `Pairing code: ${code}`,
          "",
          "Ask the bot owner to approve with:",
          formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
        ]
      : [
          "OpenClaw: access not configured.",
          "",
          idLine,
          "",
          `Pairing code: ${code}`,
          "",
          "Ask the bot owner to approve with:",
          formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
        ];
  return lines.join("\n");
}
