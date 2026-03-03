import { z } from "zod";
import { hasConfiguredSecretInput } from "./types.secrets.js";

type TelegramAccountLike = {
  enabled?: unknown;
  webhookUrl?: unknown;
  webhookSecret?: unknown;
};

type TelegramConfigLike = {
  webhookUrl?: unknown;
  webhookSecret?: unknown;
  accounts?: Record<string, TelegramAccountLike | undefined>;
};

type SlackAccountLike = {
  enabled?: unknown;
  mode?: unknown;
  signingSecret?: unknown;
};

type SlackConfigLike = {
  mode?: unknown;
  signingSecret?: unknown;
  accounts?: Record<string, SlackAccountLike | undefined>;
};

export function validateTelegramWebhookSecretRequirements(
  value: TelegramConfigLike,
  ctx: z.RefinementCtx,
): void {
  const baseWebhookUrl = typeof value.webhookUrl === "string" ? value.webhookUrl.trim() : "";
  const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
  if (baseWebhookUrl && !hasBaseWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
      path: ["webhookSecret"],
    });
  }
  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountWebhookUrl =
      typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "";
    if (!accountWebhookUrl) {
      continue;
    }
    const hasAccountSecret = hasConfiguredSecretInput(account.webhookSecret);
    if (!hasAccountSecret && !hasBaseWebhookSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
        path: ["accounts", accountId, "webhookSecret"],
      });
    }
  }
}

export function validateSlackSigningSecretRequirements(
  value: SlackConfigLike,
  ctx: z.RefinementCtx,
): void {
  const baseMode = value.mode === "http" || value.mode === "socket" ? value.mode : "socket";
  if (baseMode === "http" && !hasConfiguredSecretInput(value.signingSecret)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'channels.slack.mode="http" requires channels.slack.signingSecret',
      path: ["signingSecret"],
    });
  }
  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountMode =
      account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
    if (accountMode !== "http") {
      continue;
    }
    const accountSecret = account.signingSecret ?? value.signingSecret;
    if (!hasConfiguredSecretInput(accountSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'channels.slack.accounts.*.mode="http" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret',
        path: ["accounts", accountId, "signingSecret"],
      });
    }
  }
}
