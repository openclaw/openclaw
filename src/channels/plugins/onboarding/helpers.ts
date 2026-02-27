import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy, GroupPolicy } from "../../../config/types.js";
import { promptAccountId as promptAccountIdSdk } from "../../../plugin-sdk/onboarding.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { PromptAccountId, PromptAccountIdParams } from "../onboarding-types.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "../setup-helpers.js";

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

type ParsedOnboardingEntry = { value: string } | { error: string };

export function parseOnboardingEntriesWithParser(
  raw: string,
  parseEntry: (entry: string) => ParsedOnboardingEntry,
): { entries: string[]; error?: string } {
  const parts = splitOnboardingEntries(String(raw ?? ""));
  const entries: string[] = [];
  for (const part of parts) {
    const parsed = parseEntry(part);
    if ("error" in parsed) {
      return { entries: [], error: parsed.error };
    }
    entries.push(parsed.value);
  }
  return { entries: normalizeAllowFromEntries(entries) };
}

export function parseOnboardingEntriesAllowingWildcard(
  raw: string,
  parseEntry: (entry: string) => ParsedOnboardingEntry,
): { entries: string[]; error?: string } {
  return parseOnboardingEntriesWithParser(raw, (entry) => {
    if (entry === "*") {
      return { value: "*" };
    }
    return parseEntry(entry);
  });
}

export function parseMentionOrPrefixedId(params: {
  value: string;
  mentionPattern: RegExp;
  prefixPattern?: RegExp;
  idPattern: RegExp;
  normalizeId?: (id: string) => string;
}): string | null {
  const trimmed = params.value.trim();
  if (!trimmed) {
    return null;
  }

  const mentionMatch = trimmed.match(params.mentionPattern);
  if (mentionMatch?.[1]) {
    return params.normalizeId ? params.normalizeId(mentionMatch[1]) : mentionMatch[1];
  }

  const stripped = params.prefixPattern ? trimmed.replace(params.prefixPattern, "") : trimmed;
  if (!params.idPattern.test(stripped)) {
    return null;
  }

  return params.normalizeId ? params.normalizeId(stripped) : stripped;
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
  return patchConfigForScopedAccount({
    cfg,
    channel,
    accountId,
    patch: { allowFrom },
    ensureEnabled: false,
  });
}

export function setChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: "imessage" | "signal" | "telegram";
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

export function setLegacyChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: LegacyDmChannel;
  dmPolicy: DmPolicy;
}): OpenClawConfig {
  const channelConfig = (params.cfg.channels?.[params.channel] as
    | {
        allowFrom?: Array<string | number>;
        dm?: { allowFrom?: Array<string | number> };
      }
    | undefined) ?? {
    allowFrom: undefined,
    dm: undefined,
  };
  const existingAllowFrom = channelConfig.allowFrom ?? channelConfig.dm?.allowFrom;
  const allowFrom =
    params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
  return patchLegacyDmChannelConfig({
    cfg: params.cfg,
    channel: params.channel,
    patch: {
      dmPolicy: params.dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  });
}

export function setLegacyChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: LegacyDmChannel;
  allowFrom: string[];
}): OpenClawConfig {
  return patchLegacyDmChannelConfig({
    cfg: params.cfg,
    channel: params.channel,
    patch: { allowFrom: params.allowFrom },
  });
}

export function setAccountGroupPolicyForChannel(params: {
  cfg: OpenClawConfig;
  channel: "discord" | "slack";
  accountId: string;
  groupPolicy: GroupPolicy;
}): OpenClawConfig {
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    patch: { groupPolicy: params.groupPolicy },
  });
}

type AccountScopedChannel = "discord" | "slack" | "telegram" | "imessage" | "signal";
type LegacyDmChannel = "discord" | "slack";

export function patchLegacyDmChannelConfig(params: {
  cfg: OpenClawConfig;
  channel: LegacyDmChannel;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, channel, patch } = params;
  const channelConfig = (cfg.channels?.[channel] as Record<string, unknown> | undefined) ?? {};
  const dmConfig = (channelConfig.dm as Record<string, unknown> | undefined) ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...channelConfig,
        ...patch,
        dm: {
          ...dmConfig,
          enabled: typeof dmConfig.enabled === "boolean" ? dmConfig.enabled : true,
        },
      },
    },
  };
}

export function setOnboardingChannelEnabled(
  cfg: OpenClawConfig,
  channel: AccountScopedChannel,
  enabled: boolean,
): OpenClawConfig {
  const channelConfig = (cfg.channels?.[channel] as Record<string, unknown> | undefined) ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...channelConfig,
        enabled,
      },
    },
  };
}

function patchConfigForScopedAccount(params: {
  cfg: OpenClawConfig;
  channel: AccountScopedChannel;
  accountId: string;
  patch: Record<string, unknown>;
  ensureEnabled: boolean;
}): OpenClawConfig {
  const { cfg, channel, accountId, patch, ensureEnabled } = params;
  const seededCfg =
    accountId === DEFAULT_ACCOUNT_ID
      ? cfg
      : moveSingleAccountChannelSectionToDefaultAccount({
          cfg,
          channelKey: channel,
        });
  const channelConfig =
    (seededCfg.channels?.[channel] as Record<string, unknown> | undefined) ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...seededCfg,
      channels: {
        ...seededCfg.channels,
        [channel]: {
          ...channelConfig,
          ...(ensureEnabled ? { enabled: true } : {}),
          ...patch,
        },
      },
    };
  }

  const accounts =
    (channelConfig.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
  const existingAccount = accounts[accountId] ?? {};

  return {
    ...seededCfg,
    channels: {
      ...seededCfg.channels,
      [channel]: {
        ...channelConfig,
        ...(ensureEnabled ? { enabled: true } : {}),
        accounts: {
          ...accounts,
          [accountId]: {
            ...existingAccount,
            ...(ensureEnabled
              ? {
                  enabled:
                    typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true,
                }
              : {}),
            ...patch,
          },
        },
      },
    },
  };
}

export function patchChannelConfigForAccount(params: {
  cfg: OpenClawConfig;
  channel: AccountScopedChannel;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchConfigForScopedAccount({
    ...params,
    ensureEnabled: true,
  });
}

export function applySingleTokenPromptResult(params: {
  cfg: OpenClawConfig;
  channel: "discord" | "telegram";
  accountId: string;
  tokenPatchKey: "token" | "botToken";
  tokenResult: {
    useEnv: boolean;
    token: string | null;
  };
}): OpenClawConfig {
  let next = params.cfg;
  if (params.tokenResult.useEnv) {
    next = patchChannelConfigForAccount({
      cfg: next,
      channel: params.channel,
      accountId: params.accountId,
      patch: {},
    });
  }
  if (params.tokenResult.token) {
    next = patchChannelConfigForAccount({
      cfg: next,
      channel: params.channel,
      accountId: params.accountId,
      patch: { [params.tokenPatchKey]: params.tokenResult.token },
    });
  }
  return next;
}

export async function promptSingleChannelToken(params: {
  prompter: Pick<WizardPrompter, "confirm" | "text">;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
}): Promise<{ useEnv: boolean; token: string | null }> {
  const promptToken = async (): Promise<string> =>
    String(
      await params.prompter.text({
        message: params.inputPrompt,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();

  if (params.canUseEnv) {
    const keepEnv = await params.prompter.confirm({
      message: params.envPrompt,
      initialValue: true,
    });
    if (keepEnv) {
      return { useEnv: true, token: null };
    }
    return { useEnv: false, token: await promptToken() };
  }

  if (params.hasConfigToken && params.accountConfigured) {
    const keep = await params.prompter.confirm({
      message: params.keepPrompt,
      initialValue: true,
    });
    if (keep) {
      return { useEnv: false, token: null };
    }
  }

  return { useEnv: false, token: await promptToken() };
}

type ParsedAllowFromResult = { entries: string[]; error?: string };

export async function promptParsedAllowFromForScopedChannel(params: {
  cfg: OpenClawConfig;
  channel: "imessage" | "signal";
  accountId?: string;
  defaultAccountId: string;
  prompter: Pick<WizardPrompter, "note" | "text">;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseEntries: (raw: string) => ParsedAllowFromResult;
  getExistingAllowFrom: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => Array<string | number>;
}): Promise<OpenClawConfig> {
  const accountId = resolveOnboardingAccountId({
    accountId: params.accountId,
    defaultAccountId: params.defaultAccountId,
  });
  const existing = params.getExistingAllowFrom({
    cfg: params.cfg,
    accountId,
  });
  await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
  const entry = await params.prompter.text({
    message: params.message,
    placeholder: params.placeholder,
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      return params.parseEntries(raw).error;
    },
  });
  const parsed = params.parseEntries(String(entry));
  const unique = mergeAllowFromEntries(undefined, parsed.entries);
  return setAccountAllowFromForChannel({
    cfg: params.cfg,
    channel: params.channel,
    accountId,
    allowFrom: unique,
  });
}

export async function noteChannelLookupSummary(params: {
  prompter: Pick<WizardPrompter, "note">;
  label: string;
  resolvedSections: Array<{ title: string; values: string[] }>;
  unresolved?: string[];
}): Promise<void> {
  const lines: string[] = [];
  for (const section of params.resolvedSections) {
    if (section.values.length === 0) {
      continue;
    }
    lines.push(`${section.title}: ${section.values.join(", ")}`);
  }
  if (params.unresolved && params.unresolved.length > 0) {
    lines.push(`Unresolved (kept as typed): ${params.unresolved.join(", ")}`);
  }
  if (lines.length > 0) {
    await params.prompter.note(lines.join("\n"), params.label);
  }
}

export async function noteChannelLookupFailure(params: {
  prompter: Pick<WizardPrompter, "note">;
  label: string;
  error: unknown;
}): Promise<void> {
  await params.prompter.note(
    `Channel lookup failed; keeping entries as typed. ${String(params.error)}`,
    params.label,
  );
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

export async function promptLegacyChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: LegacyDmChannel;
  prompter: WizardPrompter;
  existing: Array<string | number>;
  token?: string | null;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: { token: string; entries: string[] }) => Promise<AllowFromResolution[]>;
}): Promise<OpenClawConfig> {
  await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
  const unique = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: params.existing,
    token: params.token,
    message: params.message,
    placeholder: params.placeholder,
    label: params.noteTitle,
    parseInputs: splitOnboardingEntries,
    parseId: params.parseId,
    invalidWithoutTokenNote: params.invalidWithoutTokenNote,
    resolveEntries: params.resolveEntries,
  });
  return setLegacyChannelAllowFrom({
    cfg: params.cfg,
    channel: params.channel,
    allowFrom: unique,
  });
}
