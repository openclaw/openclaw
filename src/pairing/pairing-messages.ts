import type { PairingChannel } from "./pairing-store.types.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { channel, code } = params;
  return [
    "🔗 Almost done!",
    `To connect your ${channel} to this assistant:`,
    "1. Copy this code:",
    "```",
    code,
    "```",
    "2. Go back to Baseer Burhan",
    "3. Go to your created assistant",
    "3. Paste it in the “Pairing Code” section",
    "Once submitted, your bot will be ready ✅",
  ].join("\n");
}
