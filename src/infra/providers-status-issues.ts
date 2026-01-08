export type ProviderStatusIssue = {
  provider: "discord";
  accountId: string;
  kind: "intent" | "permissions" | "config";
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

export function collectProvidersStatusIssues(
  payload: Record<string, unknown>,
): ProviderStatusIssue[] {
  const issues: ProviderStatusIssue[] = [];
  const discordAccountsRaw = payload.discordAccounts;
  if (!Array.isArray(discordAccountsRaw)) return issues;

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

  return issues;
}

