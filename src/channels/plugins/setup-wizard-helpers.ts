import type { OpenClawConfig } from "../../config/config.js";
import type { DmPolicy, GroupPolicy } from "../../config/types.js";
import type { SecretInput } from "../../config/types.secrets.js";
import {
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../../plugins/provider-auth-input.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  moveSingleAccountChannelSectionToDefaultAccount,
  patchScopedAccountConfig,
} from "./setup-helpers.js";
import type {
  ChannelSetupDmPolicy,
  PromptAccountId,
  PromptAccountIdParams,
} from "./setup-wizard-types.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

export const promptAccountId: PromptAccountId = async (params: PromptAccountIdParams) => {
  const existingIds = params.listAccountIds(params.cfg);
  const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = await params.prompter.select({
    message: `${params.label} account`,
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
      })),
      { value: "__new__", label: "Add a new account" },
    ],
    initialValue: initial,
  });

  if (choice !== "__new__") {
    return normalizeAccountId(choice);
  }

  const entered = await params.prompter.text({
    message: `New ${params.label} account id`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(
      `Normalized account id to "${normalized}".`,
      `${params.label} account`,
    );
  }
  return normalized;
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

export function splitSetupEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

type ParsedSetupEntry = { value: string } | { error: string };

export function parseSetupEntriesWithParser(
  raw: string,
  parseEntry: (entry: string) => ParsedSetupEntry,
): { entries: string[]; error?: string } {
  const parts = splitSetupEntries(String(raw ?? ""));
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

export function parseSetupEntriesAllowingWildcard(
  raw: string,
  parseEntry: (entry: string) => ParsedSetupEntry,
): { entries: string[]; error?: string } {
  return parseSetupEntriesWithParser(raw, (entry) => {
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

export function resolveSetupAccountId(params: {
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

export function patchTopLevelChannelConfigSection(params: {
  cfg: OpenClawConfig;
  channel: string;
  enabled?: boolean;
  clearFields?: string[];
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const channelConfig = {
    ...(params.cfg.channels?.[params.channel] as Record<string, unknown> | undefined),
  };
  for (const field of params.clearFields ?? []) {
    delete channelConfig[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channel]: {
        ...channelConfig,
        ...(params.enabled ? { enabled: true } : {}),
        ...params.patch,
      },
    },
  };
}

export function patchNestedChannelConfigSection(params: {
  cfg: OpenClawConfig;
  channel: string;
  section: string;
  enabled?: boolean;
  clearFields?: string[];
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const channelConfig = {
    ...(params.cfg.channels?.[params.channel] as Record<string, unknown> | undefined),
  };
  const sectionConfig = {
    ...(channelConfig[params.section] as Record<string, unknown> | undefined),
  };
  for (const field of params.clearFields ?? []) {
    delete sectionConfig[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channel]: {
        ...channelConfig,
        ...(params.enabled ? { enabled: true } : {}),
        [params.section]: {
          ...sectionConfig,
          ...params.patch,
        },
      },
    },
  };
}

export function setTopLevelChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  allowFrom: string[];
  enabled?: boolean;
}): OpenClawConfig {
  return patchTopLevelChannelConfigSection({
    cfg: params.cfg,
    channel: params.channel,
    enabled: params.enabled,
    patch: { allowFrom: params.allowFrom },
  });
}

export function setNestedChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  section: string;
  allowFrom: string[];
  enabled?: boolean;
}): OpenClawConfig {
  return patchNestedChannelConfigSection({
    cfg: params.cfg,
    channel: params.channel,
    section: params.section,
    enabled: params.enabled,
    patch: { allowFrom: params.allowFrom },
  });
}

export function setTopLevelChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  dmPolicy: DmPolicy;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
}): OpenClawConfig {
  const channelConfig =
    (params.cfg.channels?.[params.channel] as Record<string, unknown> | undefined) ?? {};
  const existingAllowFrom =
    params.getAllowFrom?.(params.cfg) ??
    (channelConfig.allowFrom as Array<string | number> | undefined) ??
    undefined;
  const allowFrom =
    params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
  return patchTopLevelChannelConfigSection({
    cfg: params.cfg,
    channel: params.channel,
    patch: {
      dmPolicy: params.dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  });
}

export function setNestedChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  section: string;
  dmPolicy: DmPolicy;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  enabled?: boolean;
}): OpenClawConfig {
  const channelConfig =
    (params.cfg.channels?.[params.channel] as Record<string, unknown> | undefined) ?? {};
  const sectionConfig =
    (channelConfig[params.section] as Record<string, unknown> | undefined) ?? {};
  const existingAllowFrom =
    params.getAllowFrom?.(params.cfg) ??
    (sectionConfig.allowFrom as Array<string | number> | undefined) ??
    undefined;
  const allowFrom =
    params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
  return patchNestedChannelConfigSection({
    cfg: params.cfg,
    channel: params.channel,
    section: params.section,
    enabled: params.enabled,
    patch: {
      policy: params.dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  });
}

export function setTopLevelChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  groupPolicy: GroupPolicy;
  enabled?: boolean;
}): OpenClawConfig {
  return patchTopLevelChannelConfigSection({
    cfg: params.cfg,
    channel: params.channel,
    enabled: params.enabled,
    patch: { groupPolicy: params.groupPolicy },
  });
}

export function createTopLevelChannelDmPolicy(params: {
  label: string;
  channel: string;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
}): ChannelSetupDmPolicy {
  const setPolicy = createTopLevelChannelDmPolicySetter({
    channel: params.channel,
    getAllowFrom: params.getAllowFrom,
  });
  return {
    label: params.label,
    channel: params.channel,
    policyKey: params.policyKey,
    allowFromKey: params.allowFromKey,
    getCurrent: params.getCurrent,
    setPolicy,
    ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
  };
}

export function createNestedChannelDmPolicy(params: {
  label: string;
  channel: string;
  section: string;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  enabled?: boolean;
}): ChannelSetupDmPolicy {
  const setPolicy = createNestedChannelDmPolicySetter({
    channel: params.channel,
    section: params.section,
    getAllowFrom: params.getAllowFrom,
    enabled: params.enabled,
  });
  return {
    label: params.label,
    channel: params.channel,
    policyKey: params.policyKey,
    allowFromKey: params.allowFromKey,
    getCurrent: params.getCurrent,
    setPolicy,
    ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
  };
}

export function createTopLevelChannelDmPolicySetter(params: {
  channel: string;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
}): (cfg: OpenClawConfig, dmPolicy: DmPolicy) => OpenClawConfig {
  return (cfg, dmPolicy) =>
    setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel: params.channel,
      dmPolicy,
      getAllowFrom: params.getAllowFrom,
    });
}

export function createNestedChannelDmPolicySetter(params: {
  channel: string;
  section: string;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  enabled?: boolean;
}): (cfg: OpenClawConfig, dmPolicy: DmPolicy) => OpenClawConfig {
  return (cfg, dmPolicy) =>
    setNestedChannelDmPolicyWithAllowFrom({
      cfg,
      channel: params.channel,
      section: params.section,
      dmPolicy,
      getAllowFrom: params.getAllowFrom,
      enabled: params.enabled,
    });
}

export function createTopLevelChannelAllowFromSetter(params: {
  channel: string;
  enabled?: boolean;
}): (cfg: OpenClawConfig, allowFrom: string[]) => OpenClawConfig {
  return (cfg, allowFrom) =>
    setTopLevelChannelAllowFrom({
      cfg,
      channel: params.channel,
      allowFrom,
      enabled: params.enabled,
    });
}

export function createNestedChannelAllowFromSetter(params: {
  channel: string;
  section: string;
  enabled?: boolean;
}): (cfg: OpenClawConfig, allowFrom: string[]) => OpenClawConfig {
  return (cfg, allowFrom) =>
    setNestedChannelAllowFrom({
      cfg,
      channel: params.channel,
      section: params.section,
      allowFrom,
      enabled: params.enabled,
    });
}

export function createTopLevelChannelGroupPolicySetter(params: {
  channel: string;
  enabled?: boolean;
}): (cfg: OpenClawConfig, groupPolicy: "open" | "allowlist" | "disabled") => OpenClawConfig {
  return (cfg, groupPolicy) =>
    setTopLevelChannelGroupPolicy({
      cfg,
      channel: params.channel,
      groupPolicy,
      enabled: params.enabled,
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

export function setAccountDmAllowFromForChannel(params: {
  cfg: OpenClawConfig;
  channel: "discord" | "slack";
  accountId: string;
  allowFrom: string[];
}): OpenClawConfig {
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    patch: { dmPolicy: "allowlist", allowFrom: params.allowFrom },
  });
}

export function createLegacyCompatChannelDmPolicy(params: {
  label: string;
  channel: LegacyDmChannel;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
}): ChannelSetupDmPolicy {
  return {
    label: params.label,
    channel: params.channel,
    policyKey: `channels.${params.channel}.dmPolicy`,
    allowFromKey: `channels.${params.channel}.allowFrom`,
    getCurrent: (cfg) =>
      (
        cfg.channels?.[params.channel] as
          | {
              dmPolicy?: DmPolicy;
              dm?: { policy?: DmPolicy };
            }
          | undefined
      )?.dmPolicy ??
      (
        cfg.channels?.[params.channel] as
          | {
              dmPolicy?: DmPolicy;
              dm?: { policy?: DmPolicy };
            }
          | undefined
      )?.dm?.policy ??
      "pairing",
    setPolicy: (cfg, policy) =>
      setLegacyChannelDmPolicyWithAllowFrom({
        cfg,
        channel: params.channel,
        dmPolicy: policy,
      }),
    ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
  };
}

export async function resolveGroupAllowlistWithLookupNotes<TResolved>(params: {
  label: string;
  prompter: Pick<WizardPrompter, "note">;
  entries: string[];
  fallback: TResolved;
  resolve: () => Promise<TResolved>;
}): Promise<TResolved> {
  try {
    return await params.resolve();
  } catch (error) {
    await noteChannelLookupFailure({
      prompter: params.prompter,
      label: params.label,
      error,
    });
    await noteChannelLookupSummary({
      prompter: params.prompter,
      label: params.label,
      resolvedSections: [],
      unresolved: params.entries,
    });
    return params.fallback;
  }
}

export function createAccountScopedAllowFromSection(params: {
  channel: "discord" | "slack";
  credentialInputKey?: NonNullable<ChannelSetupWizard["allowFrom"]>["credentialInputKey"];
  helpTitle?: string;
  helpLines?: string[];
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseId: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["parseId"]>;
  resolveEntries: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>;
}): NonNullable<ChannelSetupWizard["allowFrom"]> {
  return {
    ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
    ...(params.helpLines ? { helpLines: params.helpLines } : {}),
    ...(params.credentialInputKey ? { credentialInputKey: params.credentialInputKey } : {}),
    message: params.message,
    placeholder: params.placeholder,
    invalidWithoutCredentialNote: params.invalidWithoutCredentialNote,
    parseId: params.parseId,
    resolveEntries: params.resolveEntries,
    apply: ({ cfg, accountId, allowFrom }) =>
      setAccountDmAllowFromForChannel({
        cfg,
        channel: params.channel,
        accountId,
        allowFrom,
      }),
  };
}

export function createAccountScopedGroupAccessSection<TResolved>(params: {
  channel: "discord" | "slack";
  label: string;
  placeholder: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: NonNullable<ChannelSetupWizard["groupAccess"]>["currentPolicy"];
  currentEntries: NonNullable<ChannelSetupWizard["groupAccess"]>["currentEntries"];
  updatePrompt: NonNullable<ChannelSetupWizard["groupAccess"]>["updatePrompt"];
  resolveAllowlist?: NonNullable<
    NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]
  >;
  fallbackResolved: (entries: string[]) => TResolved;
  applyAllowlist: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: TResolved;
  }) => OpenClawConfig;
}): NonNullable<ChannelSetupWizard["groupAccess"]> {
  return {
    label: params.label,
    placeholder: params.placeholder,
    ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
    ...(params.helpLines ? { helpLines: params.helpLines } : {}),
    ...(params.skipAllowlistEntries ? { skipAllowlistEntries: true } : {}),
    currentPolicy: params.currentPolicy,
    currentEntries: params.currentEntries,
    updatePrompt: params.updatePrompt,
    setPolicy: ({ cfg, accountId, policy }) =>
      setAccountGroupPolicyForChannel({
        cfg,
        channel: params.channel,
        accountId,
        groupPolicy: policy,
      }),
    ...(params.resolveAllowlist
      ? {
          resolveAllowlist: ({ cfg, accountId, credentialValues, entries, prompter }) =>
            resolveGroupAllowlistWithLookupNotes({
              label: params.label,
              prompter,
              entries,
              fallback: params.fallbackResolved(entries),
              resolve: async () =>
                await params.resolveAllowlist!({
                  cfg,
                  accountId,
                  credentialValues,
                  entries,
                  prompter,
                }),
            }),
        }
      : {}),
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      params.applyAllowlist({
        cfg,
        accountId,
        resolved: resolved as TResolved,
      }),
  };
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

export function setSetupChannelEnabled(
  cfg: OpenClawConfig,
  channel: string,
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
  return patchScopedAccountConfig({
    cfg: seededCfg,
    channelKey: channel,
    accountId,
    patch,
    ensureChannelEnabled: ensureEnabled,
    ensureAccountEnabled: ensureEnabled,
  });
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
    token: SecretInput | null;
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

export function buildSingleChannelSecretPromptState(params: {
  accountConfigured: boolean;
  hasConfigToken: boolean;
  allowEnv: boolean;
  envValue?: string;
}): {
  accountConfigured: boolean;
  hasConfigToken: boolean;
  canUseEnv: boolean;
} {
  return {
    accountConfigured: params.accountConfigured,
    hasConfigToken: params.hasConfigToken,
    canUseEnv: params.allowEnv && Boolean(params.envValue?.trim()) && !params.hasConfigToken,
  };
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

export type SingleChannelSecretInputPromptResult =
  | { action: "keep" }
  | { action: "use-env" }
  | { action: "set"; value: SecretInput; resolvedValue: string };

export async function runSingleChannelSecretStep(params: {
  cfg: OpenClawConfig;
  prompter: Pick<WizardPrompter, "confirm" | "text" | "select" | "note">;
  providerHint: string;
  credentialLabel: string;
  secretInputMode?: "plaintext" | "ref";
  accountConfigured: boolean;
  hasConfigToken: boolean;
  allowEnv: boolean;
  envValue?: string;
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  preferredEnvVar?: string;
  onMissingConfigured?: () => Promise<void>;
  applyUseEnv?: (cfg: OpenClawConfig) => OpenClawConfig | Promise<OpenClawConfig>;
  applySet?: (
    cfg: OpenClawConfig,
    value: SecretInput,
    resolvedValue: string,
  ) => OpenClawConfig | Promise<OpenClawConfig>;
}): Promise<{
  cfg: OpenClawConfig;
  action: SingleChannelSecretInputPromptResult["action"];
  resolvedValue?: string;
}> {
  const promptState = buildSingleChannelSecretPromptState({
    accountConfigured: params.accountConfigured,
    hasConfigToken: params.hasConfigToken,
    allowEnv: params.allowEnv,
    envValue: params.envValue,
  });

  if (!promptState.accountConfigured && params.onMissingConfigured) {
    await params.onMissingConfigured();
  }

  const result = await promptSingleChannelSecretInput({
    cfg: params.cfg,
    prompter: params.prompter,
    providerHint: params.providerHint,
    credentialLabel: params.credentialLabel,
    secretInputMode: params.secretInputMode,
    accountConfigured: promptState.accountConfigured,
    canUseEnv: promptState.canUseEnv,
    hasConfigToken: promptState.hasConfigToken,
    envPrompt: params.envPrompt,
    keepPrompt: params.keepPrompt,
    inputPrompt: params.inputPrompt,
    preferredEnvVar: params.preferredEnvVar,
  });

  if (result.action === "use-env") {
    return {
      cfg: params.applyUseEnv ? await params.applyUseEnv(params.cfg) : params.cfg,
      action: result.action,
      resolvedValue: params.envValue?.trim() || undefined,
    };
  }

  if (result.action === "set") {
    return {
      cfg: params.applySet
        ? await params.applySet(params.cfg, result.value, result.resolvedValue)
        : params.cfg,
      action: result.action,
      resolvedValue: result.resolvedValue,
    };
  }

  return {
    cfg: params.cfg,
    action: result.action,
  };
}

export async function promptSingleChannelSecretInput(params: {
  cfg: OpenClawConfig;
  prompter: Pick<WizardPrompter, "confirm" | "text" | "select" | "note">;
  providerHint: string;
  credentialLabel: string;
  secretInputMode?: "plaintext" | "ref";
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  preferredEnvVar?: string;
}): Promise<SingleChannelSecretInputPromptResult> {
  const selectedMode = await resolveSecretInputModeForEnvSelection({
    prompter: params.prompter as WizardPrompter,
    explicitMode: params.secretInputMode,
    copy: {
      modeMessage: `How do you want to provide this ${params.credentialLabel}?`,
      plaintextLabel: `Enter ${params.credentialLabel}`,
      plaintextHint: "Stores the credential directly in OpenClaw config",
      refLabel: "Use external secret provider",
      refHint: "Stores a reference to env or configured external secret providers",
    },
  });

  if (selectedMode === "plaintext") {
    const plainResult = await promptSingleChannelToken({
      prompter: params.prompter,
      accountConfigured: params.accountConfigured,
      canUseEnv: params.canUseEnv,
      hasConfigToken: params.hasConfigToken,
      envPrompt: params.envPrompt,
      keepPrompt: params.keepPrompt,
      inputPrompt: params.inputPrompt,
    });
    if (plainResult.useEnv) {
      return { action: "use-env" };
    }
    if (plainResult.token) {
      return { action: "set", value: plainResult.token, resolvedValue: plainResult.token };
    }
    return { action: "keep" };
  }

  if (params.hasConfigToken && params.accountConfigured) {
    const keep = await params.prompter.confirm({
      message: params.keepPrompt,
      initialValue: true,
    });
    if (keep) {
      return { action: "keep" };
    }
  }

  const resolved = await promptSecretRefForSetup({
    provider: params.providerHint,
    config: params.cfg,
    prompter: params.prompter as WizardPrompter,
    preferredEnvVar: params.preferredEnvVar,
    copy: {
      sourceMessage: `Where is this ${params.credentialLabel} stored?`,
      envVarPlaceholder: params.preferredEnvVar ?? "OPENCLAW_SECRET",
      envVarFormatError:
        'Use an env var name like "OPENCLAW_SECRET" (uppercase letters, numbers, underscores).',
      noProvidersMessage:
        "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.",
    },
  });
  return {
    action: "set",
    value: resolved.ref,
    resolvedValue: resolved.resolvedValue,
  };
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
  const accountId = resolveSetupAccountId({
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

export async function resolveEntriesWithOptionalToken<TResult>(params: {
  token?: string | null;
  entries: string[];
  buildWithoutToken: (input: string) => TResult;
  resolveEntries: (params: { token: string; entries: string[] }) => Promise<TResult[]>;
}): Promise<TResult[]> {
  const token = params.token?.trim();
  if (!token) {
    return params.entries.map(params.buildWithoutToken);
  }
  return await params.resolveEntries({
    token,
    entries: params.entries,
  });
}

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
    parseInputs: splitSetupEntries,
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

export async function promptLegacyChannelAllowFromForAccount<TAccount>(params: {
  cfg: OpenClawConfig;
  channel: LegacyDmChannel;
  prompter: WizardPrompter;
  accountId?: string;
  defaultAccountId: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string) => TAccount;
  resolveExisting: (account: TAccount, cfg: OpenClawConfig) => Array<string | number>;
  resolveToken: (account: TAccount) => string | null | undefined;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: { token: string; entries: string[] }) => Promise<AllowFromResolution[]>;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: params.defaultAccountId,
  });
  const account = params.resolveAccount(params.cfg, accountId);
  return await promptLegacyChannelAllowFrom({
    cfg: params.cfg,
    channel: params.channel,
    prompter: params.prompter,
    existing: params.resolveExisting(account, params.cfg),
    token: params.resolveToken(account),
    noteTitle: params.noteTitle,
    noteLines: params.noteLines,
    message: params.message,
    placeholder: params.placeholder,
    parseId: params.parseId,
    invalidWithoutTokenNote: params.invalidWithoutTokenNote,
    resolveEntries: params.resolveEntries,
  });
}
