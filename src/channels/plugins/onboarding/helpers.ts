import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { promptAccountId as promptAccountIdSdk } from "../../../plugin-sdk/onboarding.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { PromptAccountId, PromptAccountIdParams } from "../onboarding-types.js";

export const promptAccountId: PromptAccountId = async (params: PromptAccountIdParams) => {
  return await promptAccountIdSdk(params);
};

export function addWildcardAllowFrom(allowFrom?: Array<string | number> | null): string[] {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes("*")) {
    next.push("*");
  }
  return next;
}

export function mergeAllowFromEntries(
  current: Array<string | number> | null | undefined,
  additions: Array<string | number>,
): string[] {
  const merged = [...(current ?? []), ...additions].map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(merged)];
}

export function splitOnboardingEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeAllowFromEntries(
  entries: Array<string | number>,
  normalizeEntry?: (value: string) => string | null | undefined,
): string[] {
  const normalized = entries
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry === "*") {
        return "*";
      }
      if (!normalizeEntry) {
        return entry;
      }
      const value = normalizeEntry(entry);
      return typeof value === "string" ? value.trim() : "";
    })
    .filter(Boolean);
  return [...new Set(normalized)];
}

export function resolveOnboardingAccountId(params: {
  accountId?: string;
  defaultAccountId: string;
}): string {
  return params.accountId?.trim() ? normalizeAccountId(params.accountId) : params.defaultAccountId;
}

export async function resolveAccountIdForConfigure(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  accountOverride?: string;
  shouldPromptAccountIds: boolean;
  listAccountIds: (cfg: OpenClawConfig) => string[];
  defaultAccountId: string;
}): Promise<string> {
  const override = params.accountOverride?.trim();
  let accountId = override ? normalizeAccountId(override) : params.defaultAccountId;
  if (params.shouldPromptAccountIds && !override) {
    accountId = await promptAccountId({
      cfg: params.cfg,
      prompter: params.prompter,
      label: params.label,
      currentId: accountId,
      listAccountIds: params.listAccountIds,
      defaultAccountId: params.defaultAccountId,
    });
  }
  return accountId;
}

export function setAccountAllowFromForChannel(params: {
  cfg: OpenClawConfig;
  channel: "imessage" | "signal";
  accountId: string;
  allowFrom: string[];
}): OpenClawConfig {
  const { cfg, channel, accountId, allowFrom } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [channel]: {
          ...cfg.channels?.[channel],
          allowFrom,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...cfg.channels?.[channel],
        accounts: {
          ...cfg.channels?.[channel]?.accounts,
          [accountId]: {
            ...cfg.channels?.[channel]?.accounts?.[accountId],
            allowFrom,
          },
        },
      },
    },
  };
}

export function setChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: "imessage" | "signal";
  dmPolicy: DmPolicy;
}): OpenClawConfig {
  const { cfg, channel, dmPolicy } = params;
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.[channel]?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...cfg.channels?.[channel],
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

type AllowFromResolution = {
  input: string;
  resolved: boolean;
  id?: string | null;
};

export async function promptResolvedAllowFrom(params: {
  prompter: WizardPrompter;
  existing: Array<string | number>;
  token?: string | null;
  message: string;
  placeholder: string;
  label: string;
  parseInputs: (value: string) => string[];
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: { token: string; entries: string[] }) => Promise<AllowFromResolution[]>;
}): Promise<string[]> {
  while (true) {
    const entry = await params.prompter.text({
      message: params.message,
      placeholder: params.placeholder,
      initialValue: params.existing[0] ? String(params.existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = params.parseInputs(String(entry));
    if (!params.token) {
      const ids = parts.map(params.parseId).filter(Boolean) as string[];
      if (ids.length !== parts.length) {
        await params.prompter.note(params.invalidWithoutTokenNote, params.label);
        continue;
      }
      return mergeAllowFromEntries(params.existing, ids);
    }

    const results = await params
      .resolveEntries({
        token: params.token,
        entries: parts,
      })
      .catch(() => null);
    if (!results) {
      await params.prompter.note("Failed to resolve usernames. Try again.", params.label);
      continue;
    }
    const unresolved = results.filter((res) => !res.resolved || !res.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`,
        params.label,
      );
      continue;
    }
    const ids = results.map((res) => res.id as string);
    return mergeAllowFromEntries(params.existing, ids);
  }
}
