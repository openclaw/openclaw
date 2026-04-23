import { z } from "zod";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  coerceSecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "./types.secrets.js";

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

type BlueBubblesAccountLike = {
  enabled?: unknown;
  serverUrl?: unknown;
  password?: unknown;
  webhookSecret?: unknown;
};

type BlueBubblesConfigLike = {
  serverUrl?: unknown;
  password?: unknown;
  webhookSecret?: unknown;
  accounts?: Record<string, BlueBubblesAccountLike | undefined>;
};

function hasMatchingSecretInput(left: unknown, right: unknown): boolean {
  const leftString = normalizeSecretInputString(left);
  const rightString = normalizeSecretInputString(right);
  if (leftString && rightString) {
    return leftString === rightString;
  }

  const leftRef = coerceSecretRef(left);
  const rightRef = coerceSecretRef(right);
  if (!leftRef || !rightRef) {
    return false;
  }

  return (
    leftRef.source === rightRef.source &&
    leftRef.provider === rightRef.provider &&
    leftRef.id === rightRef.id
  );
}

function forEachEnabledAccount<T extends { enabled?: unknown }>(
  accounts: Record<string, T | undefined> | undefined,
  run: (accountId: string, account: T) => void,
): void {
  if (!accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!account || account.enabled === false) {
      continue;
    }
    run(accountId, account);
  }
}

export function validateTelegramWebhookSecretRequirements(
  value: TelegramConfigLike,
  ctx: z.RefinementCtx,
): void {
  const baseWebhookUrl = normalizeOptionalString(value.webhookUrl) ?? "";
  const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
  if (baseWebhookUrl && !hasBaseWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
      path: ["webhookSecret"],
    });
  }
  forEachEnabledAccount(value.accounts, (accountId, account) => {
    const accountWebhookUrl = normalizeOptionalString(account.webhookUrl) ?? "";
    if (!accountWebhookUrl) {
      return;
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
  });
}

export function validateBlueBubblesWebhookSecretRequirements(
  value: BlueBubblesConfigLike,
  ctx: z.RefinementCtx,
): void {
  const baseServerUrl = normalizeOptionalString(value.serverUrl) ?? "";
  const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
  if (baseServerUrl && !hasBaseWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "channels.bluebubbles.webhookSecret is required when channels.bluebubbles.serverUrl is configured",
      path: ["webhookSecret"],
    });
  }
  if (
    baseServerUrl &&
    hasConfiguredSecretInput(value.password) &&
    hasBaseWebhookSecret &&
    hasMatchingSecretInput(value.password, value.webhookSecret)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.bluebubbles.webhookSecret must differ from channels.bluebubbles.password",
      path: ["webhookSecret"],
    });
  }
  forEachEnabledAccount(value.accounts, (accountId, account) => {
    const accountServerUrl = normalizeOptionalString(account.serverUrl) ?? "";
    if (!accountServerUrl) {
      return;
    }
    const effectivePassword = account.password ?? value.password;
    const effectiveWebhookSecret = account.webhookSecret ?? value.webhookSecret;
    if (!hasConfiguredSecretInput(effectiveWebhookSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.bluebubbles.accounts.*.webhookSecret is required when channels.bluebubbles.accounts.*.serverUrl is configured",
        path: ["accounts", accountId, "webhookSecret"],
      });
    }
    if (
      hasConfiguredSecretInput(effectivePassword) &&
      hasConfiguredSecretInput(effectiveWebhookSecret) &&
      hasMatchingSecretInput(effectivePassword, effectiveWebhookSecret)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.bluebubbles.accounts.*.webhookSecret must differ from the effective BlueBubbles password",
        path: ["accounts", accountId, "webhookSecret"],
      });
    }
  });
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
  forEachEnabledAccount(value.accounts, (accountId, account) => {
    const accountMode =
      account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
    if (accountMode !== "http") {
      return;
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
  });
}
