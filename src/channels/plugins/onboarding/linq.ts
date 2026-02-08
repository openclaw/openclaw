import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  listLinqAccountIds,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
} from "../../../linq/accounts.js";
import { normalizeLinqHandle } from "../../../linq/targets.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "linq" as const;

function setLinqDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const linq = (cfg.channels?.linq ?? {}) as Record<string, unknown>;
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(
          (linq.allowFrom as Array<string | number> | undefined),
        )
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...linq,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setLinqAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  const linq = (cfg.channels?.linq ?? {}) as Record<string, unknown>;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        linq: {
          ...linq,
          allowFrom,
        },
      },
    };
  }
  const accounts = (linq.accounts ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...linq,
        accounts: {
          ...accounts,
          [accountId]: {
            ...(accounts[accountId] as Record<string, unknown> | undefined),
            allowFrom,
          },
        },
      },
    },
  };
}

function parseLinqAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptLinqAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultLinqAccountId(params.cfg);
  const resolved = resolveLinqAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist LINQ DMs by phone number or email handle.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "Multiple entries: comma-separated.",
    ].join("\n"),
    "LINQ allowlist",
  );
  const entry = await params.prompter.text({
    message: "LINQ allowFrom (phone or email)",
    placeholder: "+15555550123, user@example.com",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts = parseLinqAllowFromInput(raw);
      for (const part of parts) {
        if (part === "*") {
          continue;
        }
        if (!normalizeLinqHandle(part)) {
          return `Invalid handle: ${part}`;
        }
      }
      return undefined;
    },
  });
  const parts = parseLinqAllowFromInput(String(entry));
  const unique = [...new Set(parts)];
  return setLinqAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "LINQ",
  channel,
  policyKey: "channels.linq.dmPolicy",
  allowFromKey: "channels.linq.allowFrom",
  getCurrent: (cfg) => {
    const linq = cfg.channels?.linq as Record<string, unknown> | undefined;
    return (linq?.dmPolicy as DmPolicy | undefined) ?? "pairing";
  },
  setPolicy: (cfg, policy) => setLinqDmPolicy(cfg, policy),
  promptAllowFrom: promptLinqAllowFrom,
};

export const linqOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listLinqAccountIds(cfg).some((accountId) => {
      const account = resolveLinqAccount({ cfg, accountId });
      return Boolean(
        account.config.apiToken ||
        account.config.tokenFile ||
        account.config.fromNumber,
      );
    });
    return {
      channel,
      configured,
      statusLines: [
        `LINQ: ${configured ? "configured" : "needs setup"}`,
      ],
      selectionHint: configured ? "token set" : "needs API token",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const linqOverride = accountOverrides.linq?.trim();
    const defaultLinqAccountId = resolveDefaultLinqAccountId(cfg);
    let linqAccountId = linqOverride
      ? normalizeAccountId(linqOverride)
      : defaultLinqAccountId;
    if (shouldPromptAccountIds && !linqOverride) {
      linqAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "LINQ",
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

    // Prompt for API token if not set
    let apiToken = resolvedAccount.config.apiToken ?? "";
    if (!apiToken) {
      const tokenEnv = process.env.LINQ_API_TOKEN?.trim();
      if (tokenEnv) {
        apiToken = tokenEnv;
      } else {
        const entered = await prompter.text({
          message: "LINQ API bearer token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        });
        apiToken = String(entered).trim();
      }
    }

    // Prompt for from number if not set
    let fromNumber = resolvedAccount.config.fromNumber ?? "";
    if (!fromNumber) {
      const entered = await prompter.text({
        message: "Sender phone number (E.164, e.g. +14155551234)",
        validate: (value) => {
          const v = String(value ?? "").trim();
          return v && /^\+\d{3,}$/.test(v) ? undefined : "Must be E.164 (e.g. +14155551234)";
        },
      });
      fromNumber = String(entered).trim();
    }

    const linq = (next.channels?.linq ?? {}) as Record<string, unknown>;
    if (linqAccountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          linq: {
            ...linq,
            enabled: true,
            apiToken,
            fromNumber,
          },
        },
      };
    } else {
      const accounts = (linq.accounts ?? {}) as Record<string, unknown>;
      next = {
        ...next,
        channels: {
          ...next.channels,
          linq: {
            ...linq,
            enabled: true,
            accounts: {
              ...accounts,
              [linqAccountId]: {
                ...(accounts[linqAccountId] as Record<string, unknown> | undefined),
                enabled: true,
                apiToken,
                fromNumber,
              },
            },
          },
        },
      };
    }

    await prompter.note(
      [
        "LINQ integration configured.",
        "Send iMessage/RCS/SMS via the LINQ Partner API.",
        "Webhook setup needed for inbound messages.",
        `Docs: ${formatDocsLink("/channels/linq", "linq")}`,
      ].join("\n"),
      "LINQ next steps",
    );

    return { cfg: next, accountId: linqAccountId };
  },
  dmPolicy,
  disable: (cfg) => {
    const linq = (cfg.channels?.linq ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        linq: { ...linq, enabled: false },
      },
    };
  },
};
