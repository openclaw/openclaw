import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import {
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "../../../zalo/accounts.js";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "zalo" as const;

type UpdateMode = "polling" | "webhook";

function setZaloDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.zalo?.allowFrom)
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setZaloUpdateMode(
  cfg: ClawdbotConfig,
  mode: UpdateMode,
  webhookUrl?: string,
  webhookSecret?: string,
): ClawdbotConfig {
  if (mode === "polling") {
    // Remove webhook config for polling mode
    const { webhookUrl: _, webhookSecret: __, ...rest } =
      cfg.channels?.zalo ?? {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: rest,
      },
    };
  }
  // Webhook mode
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        webhookUrl,
        webhookSecret,
      },
    },
  };
}

async function noteZaloTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open Zalo Bot Platform: https://bot.zaloplatforms.com",
      "2) Create a bot and get the token",
      "3) Token looks like 12345689:abc-xyz",
      "Tip: you can also set ZALO_BOT_TOKEN in your env.",
      `Docs: ${formatDocsLink("/channels/zalo")}`,
      "Website: https://clawd.bot",
    ].join("\n"),
    "Zalo bot token",
  );
}

async function promptZaloAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<ClawdbotConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZaloAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Zalo allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0]
      ? String(existingAllowFrom[0])
      : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      if (!/^\d+$/.test(raw)) return "Use a numeric Zalo user id";
      return undefined;
    },
  });
  const normalized = String(entry).trim();
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    normalized,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        enabled: true,
        accounts: {
          ...cfg.channels?.zalo?.accounts,
          [accountId]: {
            ...cfg.channels?.zalo?.accounts?.[accountId],
            enabled: cfg.channels?.zalo?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo",
  channel,
  policyKey: "channels.zalo.dmPolicy",
  allowFromKey: "channels.zalo.allowFrom",
  getCurrent: (cfg) => cfg.channels?.zalo?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setZaloDmPolicy(cfg, policy),
};

export const zaloOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listZaloAccountIds(cfg).some((accountId) =>
      Boolean(resolveZaloAccount({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Zalo: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured
        ? "recommended · configured"
        : "recommended · newcomer-friendly",
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
    const zaloOverride = accountOverrides.zalo?.trim();
    const defaultZaloAccountId = resolveDefaultZaloAccountId(cfg);
    let zaloAccountId = zaloOverride
      ? normalizeAccountId(zaloOverride)
      : defaultZaloAccountId;
    if (shouldPromptAccountIds && !zaloOverride) {
      zaloAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Zalo",
        currentId: zaloAccountId,
        listAccountIds: listZaloAccountIds,
        defaultAccountId: defaultZaloAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveZaloAccount({
      cfg: next,
      accountId: zaloAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = zaloAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.ZALO_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.botToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteZaloTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.botToken) {
      const keepEnv = await prompter.confirm({
        message: "ZALO_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
            },
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Zalo bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Zalo token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Zalo bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Zalo bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (zaloAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
              botToken: token,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
              accounts: {
                ...next.channels?.zalo?.accounts,
                [zaloAccountId]: {
                  ...next.channels?.zalo?.accounts?.[zaloAccountId],
                  enabled:
                    next.channels?.zalo?.accounts?.[zaloAccountId]?.enabled ??
                    true,
                  botToken: token,
                },
              },
            },
          },
        };
      }
    }

    // Prompt for DM policy
    const existingDmPolicy = next.channels?.zalo?.dmPolicy ?? "pairing";
    await prompter.note(
      [
        "Zalo direct chats are gated by `channels.zalo.dmPolicy`.",
        "- pairing (default): unknown senders get a pairing code; owner approves",
        "- allowlist: only allow senders in allowFrom list",
        '- open: allow all DMs (requires allowFrom to include "*")',
        "- disabled: ignore Zalo DMs",
        "",
        `Current: dmPolicy=${existingDmPolicy}`,
        `Docs: ${formatDocsLink("/channels/zalo")}`,
      ].join("\n"),
      "Zalo DM access",
    );

    const dmPolicyChoice = (await prompter.select({
      message: "How should Zalo handle new DM senders?",
      options: [
        {
          value: "pairing",
          label: "Pairing mode (new senders get a code to approve)",
        },
        {
          value: "allowlist",
          label: "Allowlist mode (only pre-approved senders)",
        },
        { value: "open", label: "Open mode (allow all DMs)" },
        { value: "disabled", label: "Disabled (ignore all DMs)" },
      ],
      initialValue: existingDmPolicy,
    })) as DmPolicy;

    next = setZaloDmPolicy(next, dmPolicyChoice);

    // If allowlist mode, prompt for allowFrom
    if (dmPolicyChoice === "allowlist" || forceAllowFrom) {
      next = await promptZaloAllowFrom({
        cfg: next,
        prompter,
        accountId: zaloAccountId,
      });
    }

    // Prompt for update mode (polling vs webhook)
    const existingWebhookUrl = next.channels?.zalo?.webhookUrl;
    const currentMode: UpdateMode = existingWebhookUrl ? "webhook" : "polling";

    await prompter.note(
      [
        "Zalo supports two ways to receive messages:",
        "- Polling: bot periodically checks for new messages (simpler, good for dev)",
        "- Webhook: Zalo pushes messages to your server (recommended for production)",
        "",
        `Current: ${currentMode}${existingWebhookUrl ? ` (${existingWebhookUrl})` : ""}`,
        "Note: getUpdates (polling) won't work if webhook is set.",
      ].join("\n"),
      "Zalo update mode",
    );

    const updateModeChoice = (await prompter.select({
      message: "How should Zalo deliver messages?",
      options: [
        {
          value: "polling",
          label: "Polling (getUpdates) - simpler, good for development",
        },
        {
          value: "webhook",
          label: "Webhook - recommended for production",
        },
      ],
      initialValue: currentMode,
    })) as UpdateMode;

    if (updateModeChoice === "webhook") {
      const webhookUrl = await prompter.text({
        message: "Webhook URL (must be HTTPS)",
        placeholder: "https://your-server.com/zalo/webhook",
        initialValue: existingWebhookUrl,
        validate: (value) => {
          const url = String(value ?? "").trim();
          if (!url) return "Required";
          if (!url.startsWith("https://")) return "Must be HTTPS URL";
          return undefined;
        },
      });

      const existingSecret = next.channels?.zalo?.webhookSecret;
      const webhookSecret = await prompter.text({
        message: "Webhook secret (8-256 chars, for X-Bot-Api-Secret-Token)",
        placeholder: "your-secret-token",
        initialValue: existingSecret,
        validate: (value) => {
          const secret = String(value ?? "").trim();
          if (!secret) return "Required";
          if (secret.length < 8) return "Must be at least 8 characters";
          if (secret.length > 256) return "Must be at most 256 characters";
          return undefined;
        },
      });

      next = setZaloUpdateMode(
        next,
        "webhook",
        String(webhookUrl).trim(),
        String(webhookSecret).trim(),
      );
    } else {
      next = setZaloUpdateMode(next, "polling");
    }

    return { cfg: next, accountId: zaloAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: { ...cfg.channels?.zalo, enabled: false },
    },
  }),
};
