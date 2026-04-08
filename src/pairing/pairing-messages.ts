import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  widgetUrl?: string;
}): string {
  const { channel, idLine, code, widgetUrl } = params;
  const lines = [
    "AgentGlob: access not configured.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to approve with:",
    formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
  ];

  if (widgetUrl) {
    lines.push(
      "",
      `Or register at: ${widgetUrl}`,
      "Registration with your channel ID grants instant access.",
    );
  }

  return lines.join("\n");
}

export function buildAllowlistReply(params: { idLine: string; widgetUrl?: string }): string {
  const { idLine, widgetUrl } = params;
  if (widgetUrl) {
    return ["This bot requires registration.", "", idLine, "", `Register at: ${widgetUrl}`].join(
      "\n",
    );
  }
  return "This bot requires registration. Contact the bot owner for access.";
}

/**
 * Build reply for subscribed access mode.
 * Directs users to register on the widget to gain access.
 */
export function buildSubscribedAccessReply(params: {
  channel: PairingChannel;
  idLine: string;
  widgetUrl?: string;
  agentName?: string;
}): string {
  const { idLine, widgetUrl, agentName } = params;
  const registerPath = agentName
    ? `${widgetUrl}/pair?agent=${encodeURIComponent(agentName)}`
    : widgetUrl;

  if (registerPath) {
    return [
      "This bot requires a subscription to use.",
      "",
      idLine,
      "",
      `Register or sign in at: ${registerPath}`,
      "Once registered, link your channel to get access.",
    ].join("\n");
  }

  return "This bot requires a subscription. Contact the bot owner for access.";
}
