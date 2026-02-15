import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { MessengerConfig } from "../../../messenger/types.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  listMessengerAccountIds,
  resolveDefaultMessengerAccountId,
  resolveMessengerAccount,
} from "../../../messenger/accounts.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "messenger" as const;

function getMessengerConfig(cfg: OpenClawConfig): MessengerConfig {
  return (cfg.channels?.messenger ?? {}) as MessengerConfig;
}

function setMessengerDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const mc = getMessengerConfig(cfg);
  const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(mc.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      messenger: {
        ...mc,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteMessengerTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to https://developers.facebook.com and create an App",
      "2) Add the Messenger product to your app",
      "3) Create or select a Facebook Page, then generate a Page Access Token",
      "4) Copy the App Secret from Settings > Basic",
      "5) Choose a Verify Token (any string you pick for webhook verification)",
      "6) In Messenger > Settings > Webhooks, set the Callback URL to:",
      "   https://<your-gateway-host>/messenger/webhook",
      "   and subscribe to: messages, messaging_postbacks",
      "Tip: you can also set MESSENGER_PAGE_ACCESS_TOKEN and MESSENGER_APP_SECRET env vars.",
      `Docs: ${formatDocsLink("/messenger", "messenger")}`,
    ].join("\n"),
    "Messenger setup",
  );
}

async function noteMessengerAllowFromHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Messenger uses Page-Scoped User IDs (PSIDs) — numeric strings.",
      "1) Send a message to your Page, then check the webhook logs for the sender PSID",
      "2) Or use the Graph API: GET /me/conversations to list recent conversations",
      `Docs: ${formatDocsLink("/messenger", "messenger")}`,
    ].join("\n"),
    "Messenger user id",
  );
}

async function promptMessengerAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveMessengerAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await noteMessengerAllowFromHelp(prompter);

  const entry = await prompter.text({
    message: "Messenger allowFrom (PSID, comma-separated)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parts = String(entry)
    .split(/[\n,;]+/g)
    .map((e) => e.trim())
    .filter(Boolean);

  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    ...parts,
  ];
  const unique = [...new Set(merged)];

  const mc = getMessengerConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        messenger: {
          ...mc,
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
      messenger: {
        ...mc,
        enabled: true,
        accounts: {
          ...mc.accounts,
          [accountId]: {
            ...mc.accounts?.[accountId],
            enabled: mc.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

async function promptMessengerAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultMessengerAccountId(params.cfg);
  return promptMessengerAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Messenger",
  channel,
  policyKey: "channels.messenger.dmPolicy",
  allowFromKey: "channels.messenger.allowFrom",
  getCurrent: (cfg) => {
    const mc = getMessengerConfig(cfg);
    return mc.dmPolicy ?? "pairing";
  },
  setPolicy: (cfg, policy) => setMessengerDmPolicy(cfg, policy),
  promptAllowFrom: promptMessengerAllowFromForAccount,
};

export const messengerOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listMessengerAccountIds(cfg).some((accountId) =>
      Boolean(resolveMessengerAccount({ cfg, accountId }).pageAccessToken),
    );
    return {
      channel,
      configured,
      statusLines: [`Messenger: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "configured" : undefined,
      quickstartScore: configured ? 1 : 5,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const messengerOverride = accountOverrides.messenger?.trim();
    const defaultAccountId = resolveDefaultMessengerAccountId(cfg);
    let messengerAccountId = messengerOverride
      ? normalizeAccountId(messengerOverride)
      : defaultAccountId;
    if (shouldPromptAccountIds && !messengerOverride) {
      messengerAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Messenger",
        currentId: messengerAccountId,
        listAccountIds: listMessengerAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveMessengerAccount({
      cfg: next,
      accountId: messengerAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.pageAccessToken);
    const allowEnv = messengerAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.pageAccessToken || resolvedAccount.config.tokenFile,
    );

    let pageAccessToken: string | null = null;
    let appSecret: string | null = null;
    let verifyToken: string | null = null;

    if (!accountConfigured) {
      await noteMessengerTokenHelp(prompter);
    }

    if (canUseEnv && !resolvedAccount.config.pageAccessToken) {
      const keepEnv = await prompter.confirm({
        message: "MESSENGER_PAGE_ACCESS_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        const mc = getMessengerConfig(next);
        next = {
          ...next,
          channels: {
            ...next.channels,
            messenger: {
              ...mc,
              enabled: true,
            },
          },
        };
      } else {
        pageAccessToken = String(
          await prompter.text({
            message: "Enter Page Access Token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Messenger token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        pageAccessToken = String(
          await prompter.text({
            message: "Enter Page Access Token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      pageAccessToken = String(
        await prompter.text({
          message: "Enter Page Access Token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    // Prompt for app secret if not configured
    if (!resolvedAccount.appSecret) {
      const canUseEnvSecret = allowEnv && Boolean(process.env.MESSENGER_APP_SECRET?.trim());
      if (canUseEnvSecret) {
        const keepEnvSecret = await prompter.confirm({
          message: "MESSENGER_APP_SECRET detected. Use env var?",
          initialValue: true,
        });
        if (!keepEnvSecret) {
          appSecret = String(
            await prompter.text({
              message: "Enter App Secret",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ).trim();
        }
      } else {
        appSecret = String(
          await prompter.text({
            message: "Enter App Secret",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    // Prompt for verify token if not configured
    if (!resolvedAccount.verifyToken) {
      const canUseEnvVerify = allowEnv && Boolean(process.env.MESSENGER_VERIFY_TOKEN?.trim());
      if (canUseEnvVerify) {
        const keepEnvVerify = await prompter.confirm({
          message: "MESSENGER_VERIFY_TOKEN detected. Use env var?",
          initialValue: true,
        });
        if (!keepEnvVerify) {
          verifyToken = String(
            await prompter.text({
              message: "Enter Verify Token (any string for webhook verification)",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ).trim();
        }
      } else {
        verifyToken = String(
          await prompter.text({
            message: "Enter Verify Token (any string for webhook verification)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    // Apply token/secret/verify to config
    const tokenFields = {
      ...(pageAccessToken ? { pageAccessToken } : {}),
      ...(appSecret ? { appSecret } : {}),
      ...(verifyToken ? { verifyToken } : {}),
    };

    if (Object.keys(tokenFields).length > 0) {
      const mc = getMessengerConfig(next);
      if (messengerAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            messenger: {
              ...mc,
              enabled: true,
              ...tokenFields,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            messenger: {
              ...mc,
              enabled: true,
              accounts: {
                ...mc.accounts,
                [messengerAccountId]: {
                  ...mc.accounts?.[messengerAccountId],
                  enabled: mc.accounts?.[messengerAccountId]?.enabled ?? true,
                  ...tokenFields,
                },
              },
            },
          },
        };
      }
    }

    if (forceAllowFrom) {
      next = await promptMessengerAllowFrom({
        cfg: next,
        prompter,
        accountId: messengerAccountId,
      });
    }

    // Show webhook setup reminder after credentials are configured
    const webhookPath = getMessengerConfig(next).webhookPath ?? "/messenger/webhook";
    await prompter.note(
      [
        "Configure the webhook in the Facebook Developer Console:",
        `  Callback URL:  https://<your-gateway-host>${webhookPath}`,
        "  Verify Token:  (the verify token you just entered)",
        "  Subscriptions: messages, messaging_postbacks",
        `Docs: ${formatDocsLink("/messenger", "messenger")}`,
      ].join("\n"),
      "Messenger webhook",
    );

    return { cfg: next, accountId: messengerAccountId };
  },
  dmPolicy,
  disable: (cfg) => {
    const mc = getMessengerConfig(cfg);
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        messenger: { ...mc, enabled: false },
      },
    };
  },
};
