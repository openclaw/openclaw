export type ProviderStatusIssue = {
  provider: "discord" | "telegram" | "whatsapp";
  accountId: string;
  kind: "intent" | "permissions" | "config" | "auth" | "runtime";
  message: string;
  fix?: string;
};

type DiscordIntentSummary = {
  messageContent?: "enabled" | "limited" | "disabled";
};

type DiscordApplicationSummary = {
  intents?: DiscordIntentSummary;
};

type DiscordAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  application?: unknown;
};

type TelegramAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  allowUnmentionedGroups?: unknown;
};

type WhatsAppAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  linked?: unknown;
  connected?: unknown;
  running?: unknown;
  reconnectAttempts?: unknown;
  lastError?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readDiscordAccountStatus(value: unknown): DiscordAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    application: value.application,
  };
}

function readDiscordApplicationSummary(value: unknown): DiscordApplicationSummary {
  if (!isRecord(value)) return {};
  const intentsRaw = value.intents;
  if (!isRecord(intentsRaw)) return {};
  return {
    intents: {
      messageContent:
        intentsRaw.messageContent === "enabled" ||
        intentsRaw.messageContent === "limited" ||
        intentsRaw.messageContent === "disabled"
          ? intentsRaw.messageContent
          : undefined,
    },
  };
}

function readTelegramAccountStatus(value: unknown): TelegramAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    allowUnmentionedGroups: value.allowUnmentionedGroups,
  };
}

function readWhatsAppAccountStatus(value: unknown): WhatsAppAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    linked: value.linked,
    connected: value.connected,
    running: value.running,
    reconnectAttempts: value.reconnectAttempts,
    lastError: value.lastError,
  };
}

export function collectProvidersStatusIssues(
  payload: Record<string, unknown>,
): ProviderStatusIssue[] {
  const issues: ProviderStatusIssue[] = [];
  const discordAccountsRaw = payload.discordAccounts;
  if (Array.isArray(discordAccountsRaw)) {
    for (const entry of discordAccountsRaw) {
      const account = readDiscordAccountStatus(entry);
      if (!account) continue;
      const accountId = asString(account.accountId) ?? "default";
      const enabled = account.enabled !== false;
      const configured = account.configured === true;
      if (!enabled || !configured) continue;

      const app = readDiscordApplicationSummary(account.application);
      const messageContent = app.intents?.messageContent;
      if (messageContent && messageContent !== "enabled") {
        issues.push({
          provider: "discord",
          accountId,
          kind: "intent",
          message: `Message Content Intent is ${messageContent}. Bot may not see normal channel messages.`,
          fix: "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation.",
        });
      }
    }
  }

  const telegramAccountsRaw = payload.telegramAccounts;
  if (Array.isArray(telegramAccountsRaw)) {
    for (const entry of telegramAccountsRaw) {
      const account = readTelegramAccountStatus(entry);
      if (!account) continue;
      const accountId = asString(account.accountId) ?? "default";
      const enabled = account.enabled !== false;
      const configured = account.configured === true;
      if (!enabled || !configured) continue;
      if (account.allowUnmentionedGroups === true) {
        issues.push({
          provider: "telegram",
          accountId,
          kind: "config",
          message:
            "Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.",
          fix: "In BotFather run /setprivacy → Disable for this bot (then restart the gateway).",
        });
      }
    }
  }

  const whatsappAccountsRaw = payload.whatsappAccounts;
  if (Array.isArray(whatsappAccountsRaw)) {
    for (const entry of whatsappAccountsRaw) {
      const account = readWhatsAppAccountStatus(entry);
      if (!account) continue;
      const accountId = asString(account.accountId) ?? "default";
      const enabled = account.enabled !== false;
      if (!enabled) continue;
      const linked = account.linked === true;
      const running = account.running === true;
      const connected = account.connected === true;
      const reconnectAttempts =
        typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
      const lastError = asString(account.lastError);

      if (!linked) {
        issues.push({
          provider: "whatsapp",
          accountId,
          kind: "auth",
          message: "Not linked (no WhatsApp Web session).",
          fix: "Run: clawdbot providers login (scan QR on the gateway host).",
        });
        continue;
      }

      if (running && !connected) {
        issues.push({
          provider: "whatsapp",
          accountId,
          kind: "runtime",
          message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
          fix: "Run: clawdbot doctor (or restart the gateway). If it persists, relink via providers login and check logs.",
        });
      }
    }
  }

  return issues;
}
