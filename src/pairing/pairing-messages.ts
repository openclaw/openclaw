import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.js";

export type PairingMessageConfig = {
  /**
   * Replaces the first line of the pairing message.
   * Default: "OpenClaw: access not configured."
   */
  header?: string;
  /**
   * Replaces the label before the sender's ID.
   * The sender ID value is still appended automatically.
   * Default: "Your {channel} sender id:" (built by each channel monitor)
   */
  senderIdLabel?: string;
  /**
   * Replaces the label before the pairing code.
   * Default: "Pairing code:"
   */
  codeLabel?: string;
  /**
   * Replaces the footer line before the CLI hint.
   * Default: "Ask the bot owner to approve with:"
   */
  footer?: string;
  /**
   * When false, suppresses the `openclaw pairing approve ...` CLI line entirely.
   * Useful for white-label deployments where exposing the tool name is undesirable.
   * Default: true
   */
  showCliHint?: boolean;
};

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  pairingMessage?: PairingMessageConfig;
}): string {
  const { channel, idLine, code, pairingMessage: cfg } = params;
  const header = cfg?.header ?? "OpenClaw: access not configured.";
  const codeLabel = cfg?.codeLabel ?? "Pairing code:";
  const footer = cfg?.footer ?? "Ask the bot owner to approve with:";
  const showCliHint = cfg?.showCliHint ?? true;

  const lines = [header, "", idLine, "", `${codeLabel} ${code}`, "", footer];
  if (showCliHint) {
    lines.push(formatCliCommand(`openclaw pairing approve ${channel} ${code}`));
  }
  return lines.join("\n");
}
