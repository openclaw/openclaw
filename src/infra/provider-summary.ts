import chalk from "chalk";
import { loadConfig, type ClawdisConfig } from "../config/config.js";
import { normalizeE164 } from "../utils.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../web/session.js";

const DEFAULT_WEBCHAT_PORT = 18788;

export async function buildProviderSummary(
  cfg?: ClawdisConfig,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];

  const webLinked = await webAuthExists();
  const authAgeMs = getWebAuthAgeMs();
  const authAge = authAgeMs === null ? "unknown" : formatAge(authAgeMs);
  const { e164 } = readWebSelfId();
  lines.push(
    webLinked
      ? chalk.green(
          `WhatsApp: linked${e164 ? ` as ${e164}` : ""} (auth ${authAge})`,
        )
      : chalk.red("WhatsApp: not linked"),
  );

  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ?? effective.telegram?.botToken;
  lines.push(
    telegramToken
      ? chalk.green("Telegram: configured")
      : chalk.cyan("Telegram: not configured"),
  );

  if (effective.webchat?.enabled === false) {
    lines.push(chalk.yellow("WebChat: disabled"));
  } else {
    const port = effective.webchat?.port ?? DEFAULT_WEBCHAT_PORT;
    lines.push(chalk.green(`WebChat: enabled (port ${port})`));
  }

  const allowFrom = effective.inbound?.allowFrom?.length
    ? effective.inbound.allowFrom.map(normalizeE164).filter(Boolean)
    : [];
  if (allowFrom.length) {
    lines.push(chalk.cyan(`AllowFrom: ${allowFrom.join(", ")}`));
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
