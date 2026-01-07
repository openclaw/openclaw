import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import { resolveTelegramToken } from "../telegram/token.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../web/session.js";

export async function buildProviderSummary(
  cfg?: ClawdbotConfig,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];

  const webEnabled = effective.web?.enabled !== false;
  if (!webEnabled) {
    lines.push("WhatsApp: disabled");
  } else {
    const webLinked = await webAuthExists();
    const authAgeMs = getWebAuthAgeMs();
    const authAge = authAgeMs === null ? "" : ` auth ${formatAge(authAgeMs)}`;
    const { e164 } = readWebSelfId();
    lines.push(
      webLinked
        ? `WhatsApp: linked${e164 ? ` ${e164}` : ""}${authAge}`
        : "WhatsApp: not linked",
    );
  }

  const telegramEnabled = effective.telegram?.enabled !== false;
  if (!telegramEnabled) {
    lines.push("Telegram: disabled");
  } else {
    const { token: telegramToken } = resolveTelegramToken(effective);
    const telegramConfigured = Boolean(telegramToken?.trim());
    lines.push(
      telegramConfigured ? "Telegram: configured" : "Telegram: not configured",
    );
  }

  const signalEnabled = effective.signal?.enabled !== false;
  if (!signalEnabled) {
    lines.push("Signal: disabled");
  } else {
    const signalConfigured =
      Boolean(effective.signal) &&
      Boolean(
        effective.signal?.account?.trim() ||
          effective.signal?.httpUrl?.trim() ||
          effective.signal?.cliPath?.trim() ||
          effective.signal?.httpHost?.trim() ||
          typeof effective.signal?.httpPort === "number" ||
          typeof effective.signal?.autoStart === "boolean",
      );
    lines.push(
      signalConfigured ? "Signal: configured" : "Signal: not configured",
    );
  }

  const imessageEnabled = effective.imessage?.enabled !== false;
  if (!imessageEnabled) {
    lines.push("iMessage: disabled");
  } else {
    const imessageConfigured = Boolean(effective.imessage);
    lines.push(
      imessageConfigured ? "iMessage: configured" : "iMessage: not configured",
    );
  }

  return lines;
}

export function formatAge(ms: number): string {
  if (ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
