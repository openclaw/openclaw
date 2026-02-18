import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  listKeybaseAccountIds,
  resolveDefaultKeybaseAccountId,
  resolveKeybaseAccount,
} from "../../../keybase/accounts.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom, mergeAllowFromEntries, promptAccountId } from "./helpers.js";

const channel = "keybase" as const;

function setKeybaseDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const keybaseConfig = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
    | Record<string, unknown>
    | undefined;
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(
          (keybaseConfig?.allowFrom as Array<string | number> | undefined) ?? undefined,
        )
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      keybase: {
        ...keybaseConfig,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setKeybaseAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  const keybaseConfig = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
    | Record<string, unknown>
    | undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        keybase: {
          ...keybaseConfig,
          allowFrom,
        },
      },
    };
  }
  const accounts = (keybaseConfig?.accounts ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      keybase: {
        ...keybaseConfig,
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

function parseKeybaseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptKeybaseAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultKeybaseAccountId(params.cfg);
  const resolved = resolveKeybaseAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist Keybase DMs by sender username.",
      "Examples:",
      "- alice",
      "- bob",
      "Multiple entries: comma-separated.",
    ].join("\n"),
    "Keybase allowlist",
  );
  const entry = await params.prompter.text({
    message: "Keybase allowFrom (username)",
    placeholder: "alice, bob",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      return undefined;
    },
  });
  const parts = parseKeybaseAllowFromInput(String(entry));
  const normalized = parts.map((part) => part.toLowerCase());
  const unique = mergeAllowFromEntries(
    undefined,
    normalized.filter((part) => part.trim().length > 0),
  );
  return setKeybaseAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Keybase",
  channel,
  policyKey: "channels.keybase.dmPolicy",
  allowFromKey: "channels.keybase.allowFrom",
  getCurrent: (cfg) => {
    const keybaseConfig = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
      | Record<string, unknown>
      | undefined;
    return (keybaseConfig?.dmPolicy as DmPolicy | undefined) ?? "pairing";
  },
  setPolicy: (cfg, policy) => setKeybaseDmPolicy(cfg, policy),
  promptAllowFrom: promptKeybaseAllowFrom,
};

export const keybaseOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listKeybaseAccountIds(cfg).some(
      (accountId) => resolveKeybaseAccount({ cfg, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`Keybase: ${configured ? "configured" : "needs setup"}`],
      selectionHint: "Keybase CLI",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const keybaseOverride = accountOverrides.keybase?.trim();
    const defaultKeybaseAccountId = resolveDefaultKeybaseAccountId(cfg);
    let keybaseAccountId = keybaseOverride
      ? normalizeAccountId(keybaseOverride)
      : defaultKeybaseAccountId;
    if (shouldPromptAccountIds && !keybaseOverride) {
      keybaseAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Keybase",
        currentId: keybaseAccountId,
        listAccountIds: listKeybaseAccountIds,
        defaultAccountId: defaultKeybaseAccountId,
      });
    }

    const keybaseConfig = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
      | Record<string, unknown>
      | undefined;
    let next: OpenClawConfig = {
      ...cfg,
      channels: {
        ...cfg.channels,
        keybase: {
          ...keybaseConfig,
          enabled: true,
        },
      },
    };

    await prompter.note(
      [
        "Keybase requires the Keybase CLI to be installed and logged in.",
        "Verify with: keybase whoami",
      ].join("\n"),
      "Keybase setup",
    );

    return { cfg: next, accountId: keybaseAccountId };
  },
  dmPolicy,
  disable: (cfg) => {
    const keybaseConfig = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
      | Record<string, unknown>
      | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        keybase: { ...keybaseConfig, enabled: false },
      },
    };
  },
};
