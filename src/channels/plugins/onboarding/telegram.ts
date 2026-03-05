import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { hasConfiguredSecretInput } from "../../../config/types.secrets.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../../../telegram/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { fetchTelegramChatId } from "../../telegram/api.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  applySingleTokenPromptResult,
  patchChannelConfigForAccount,
  promptSingleChannelSecretInput,
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  resolveOnboardingAccountId,
  setChannelDmPolicyWithAllowFrom,
  setOnboardingChannelEnabled,
  splitOnboardingEntries,
} from "./helpers.js";

const channel = "telegram" as const;

async function noteTelegramTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open Telegram and chat with @BotFather",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
      `Docs: ${formatDocsLink("/telegram")}`,
      "Website: https://openclaw.ai",
    ].join("\n"),
    "Telegram bot token",
  );
}

async function noteTelegramUserIdHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      `1) DM your bot, then read from.id in \`${formatCliCommand("openclaw logs --follow")}\` (safest)`,
      "2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
      "3) Third-party: DM @userinfobot or @getidsbot",
      `Docs: ${formatDocsLink("/telegram")}`,
      "Website: https://openclaw.ai",
    ].join("\n"),
    "Telegram user id",
  );
}

export function normalizeTelegramAllowFromInput(raw: string): string {
  return raw
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function parseTelegramAllowFromId(raw: string): string | null {
  const stripped = normalizeTelegramAllowFromInput(raw);
  return /^\d+$/.test(stripped) ? stripped : null;
}

async function promptTelegramAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
  tokenOverride?: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveTelegramAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await noteTelegramUserIdHelp(prompter);

  const token = params.tokenOverride?.trim() || resolved.token;
  if (!token) {
    await prompter.note("Telegram token missing; username lookup is unavailable.", "Telegram");
  }
  const unique = await promptResolvedAllowFrom({
    prompter,
    existing: existingAllowFrom,
    token,
    message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
    placeholder: "@username",
    label: "Telegram allowlist",
    parseInputs: splitOnboardingEntries,
    parseId: parseTelegramAllowFromId,
    invalidWithoutTokenNote:
      "Telegram token missing; use numeric sender ids (usernames require a bot token).",
    resolveEntries: async ({ token: tokenValue, entries }) => {
      const results = await Promise.all(
        entries.map(async (entry) => {
          const numericId = parseTelegramAllowFromId(entry);
          if (numericId) {
            return { input: entry, resolved: true, id: numericId };
          }
          const stripped = normalizeTelegramAllowFromInput(entry);
          if (!stripped) {
            return { input: entry, resolved: false, id: null };
          }
          const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
          const id = await fetchTelegramChatId({ token: tokenValue, chatId: username });
          return { input: entry, resolved: Boolean(id), id };
        }),
      );
      return results;
    },
  });

  return patchChannelConfigForAccount({
    cfg,
    channel: "telegram",
    accountId,
    patch: { dmPolicy: "allowlist", allowFrom: unique },
  });
}

async function promptTelegramAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveOnboardingAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultTelegramAccountId(params.cfg),
  });
  return promptTelegramAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Telegram",
  channel,
  policyKey: "channels.telegram.dmPolicy",
  allowFromKey: "channels.telegram.allowFrom",
  getCurrent: (cfg) => cfg.channels?.telegram?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "telegram",
      dmPolicy: policy,
    }),
  promptAllowFrom: promptTelegramAllowFromForAccount,
};

export const telegramOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listTelegramAccountIds(cfg).some((accountId) => {
      const account = resolveTelegramAccount({ cfg, accountId });
      return (
        Boolean(account.token) ||
        Boolean(account.config.tokenFile?.trim()) ||
        hasConfiguredSecretInput(account.config.botToken)
      );
    });
    return {
      channel,
      configured,
      statusLines: [`Telegram: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "recommended · configured" : "recommended · newcomer-friendly",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    options,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const defaultTelegramAccountId = resolveDefaultTelegramAccountId(cfg);
    const telegramAccountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Telegram",
      accountOverride: accountOverrides.telegram,
      shouldPromptAccountIds,
      listAccountIds: listTelegramAccountIds,
      defaultAccountId: defaultTelegramAccountId,
    });

    let next = cfg;
    const resolvedAccount = resolveTelegramAccount({
      cfg: next,
      accountId: telegramAccountId,
    });
    const hasConfiguredBotToken = hasConfiguredSecretInput(resolvedAccount.config.botToken);
    const hasConfigToken =
      hasConfiguredBotToken || Boolean(resolvedAccount.config.tokenFile?.trim());
    const accountConfigured = Boolean(resolvedAccount.token) || hasConfigToken;
    const allowEnv = telegramAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv && !hasConfigToken && Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());

    if (!accountConfigured) {
      await noteTelegramTokenHelp(prompter);
    }

    const tokenResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "telegram",
      credentialLabel: "Telegram bot token",
      secretInputMode: options?.secretInputMode,
      accountConfigured,
      canUseEnv,
      hasConfigToken,
      envPrompt: "TELEGRAM_BOT_TOKEN detected. Use env var?",
      keepPrompt: "Telegram token already configured. Keep it?",
      inputPrompt: "Enter Telegram bot token",
      preferredEnvVar: allowEnv ? "TELEGRAM_BOT_TOKEN" : undefined,
    });

    let resolvedTokenForAllowFrom: string | undefined;
    if (tokenResult.action === "use-env") {
      next = applySingleTokenPromptResult({
        cfg: next,
        channel: "telegram",
        accountId: telegramAccountId,
        tokenPatchKey: "botToken",
        tokenResult: { useEnv: true, token: null },
      });
      resolvedTokenForAllowFrom = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
    } else if (tokenResult.action === "set") {
      next = applySingleTokenPromptResult({
        cfg: next,
        channel: "telegram",
        accountId: telegramAccountId,
        tokenPatchKey: "botToken",
        tokenResult: { useEnv: false, token: tokenResult.value },
      });
      resolvedTokenForAllowFrom = tokenResult.resolvedValue;
    }

    if (forceAllowFrom) {
      next = await promptTelegramAllowFrom({
        cfg: next,
        prompter,
        accountId: telegramAccountId,
        tokenOverride: resolvedTokenForAllowFrom,
      });
    }

    return { cfg: next, accountId: telegramAccountId };
  },
  dmPolicy,
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};
