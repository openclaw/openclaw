import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  listLinqAccountIds,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
} from "../../../linq/accounts.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "linq" as const;

function setLinqDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.linq?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...cfg.channels?.linq,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteLinqTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Sign up at linqapp.com",
      "2) Copy your API token from the dashboard",
      "3) Tip: you can also set LINQ_API_TOKEN in your env.",
    ].join("\n"),
    "Linq API token",
  );
}

async function noteLinqPhoneHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Your Linq phone number is shown in your linqapp.com dashboard.",
      "This is the number people will text to reach your agent.",
    ].join("\n"),
    "Linq phone number",
  );
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Linq",
  channel,
  policyKey: "channels.linq.dmPolicy",
  allowFromKey: "channels.linq.allowFrom",
  getCurrent: (cfg) => cfg.channels?.linq?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setLinqDmPolicy(cfg, policy),
};

export const linqOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listLinqAccountIds(cfg).some((accountId) =>
      Boolean(resolveLinqAccount({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Linq: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured
        ? "recommended · configured"
        : "recommended · iMessage blue bubbles",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const linqOverride = accountOverrides.linq?.trim();
    const defaultLinqAccountId = resolveDefaultLinqAccountId(cfg);
    let linqAccountId = linqOverride ? normalizeAccountId(linqOverride) : defaultLinqAccountId;
    if (shouldPromptAccountIds && !linqOverride) {
      linqAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Linq",
        currentId: linqAccountId,
        listAccountIds: listLinqAccountIds,
        defaultAccountId: defaultLinqAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveLinqAccount({
      cfg: next,
      accountId: linqAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = linqAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.LINQ_API_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.apiToken || resolvedAccount.config.tokenFile,
    );

    // --- Token ---
    let token: string | null = null;
    if (!accountConfigured) {
      await noteLinqTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.apiToken) {
      const keepEnv = await prompter.confirm({
        message: "LINQ_API_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...next.channels?.linq,
              enabled: true,
            },
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Linq API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Linq token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Linq API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Linq API token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (linqAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...next.channels?.linq,
              enabled: true,
              apiToken: token,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...next.channels?.linq,
              enabled: true,
              accounts: {
                ...next.channels?.linq?.accounts,
                [linqAccountId]: {
                  ...next.channels?.linq?.accounts?.[linqAccountId],
                  enabled: next.channels?.linq?.accounts?.[linqAccountId]?.enabled ?? true,
                  apiToken: token,
                },
              },
            },
          },
        };
      }
    }

    // --- fromPhone ---
    await noteLinqPhoneHelp(prompter);
    const existingPhone = resolvedAccount.fromPhone;
    const fromPhone = String(
      await prompter.text({
        message: "Linq phone number (E.164 format, e.g. +15551234567)",
        initialValue: existingPhone,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();

    if (linqAccountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          linq: {
            ...next.channels?.linq,
            fromPhone,
          },
        },
      };
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          linq: {
            ...next.channels?.linq,
            accounts: {
              ...next.channels?.linq?.accounts,
              [linqAccountId]: {
                ...next.channels?.linq?.accounts?.[linqAccountId],
                fromPhone,
              },
            },
          },
        },
      };
    }

    // --- Webhook config ---
    const linqSection = (next.channels as Record<string, unknown> | undefined)?.linq as
      | Record<string, unknown>
      | undefined;
    const existingWebhookUrl =
      (linqSection?.webhookUrl as string) ?? "http://localhost:3100/webhook";
    const webhookUrl = String(
      await prompter.text({
        message: "Webhook URL",
        initialValue: existingWebhookUrl,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();

    const existingWebhookPath = (linqSection?.webhookPath as string) ?? "/webhook";
    const webhookPath = String(
      await prompter.text({
        message: "Webhook path",
        initialValue: existingWebhookPath,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();

    const existingWebhookHost = (linqSection?.webhookHost as string) ?? "0.0.0.0";
    const webhookHost = String(
      await prompter.text({
        message: "Webhook host",
        initialValue: existingWebhookHost,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();

    next = {
      ...next,
      channels: {
        ...next.channels,
        linq: {
          ...next.channels?.linq,
          webhookUrl,
          webhookPath,
          webhookHost,
        },
      },
    };

    // --- DM policy default ---
    if (!next.channels?.linq?.dmPolicy) {
      next = setLinqDmPolicy(next, "open");
    }

    if (forceAllowFrom) {
      // Linq doesn't have username resolution, so we skip the allowFrom prompting
      // that Telegram does. The allowFrom list uses phone numbers directly.
    }

    return { cfg: next, accountId: linqAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: { ...cfg.channels?.linq, enabled: false },
    },
  }),
};
