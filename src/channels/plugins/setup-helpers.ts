import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";

type ChannelSectionBase = {
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

function channelHasAccounts(cfg: OpenClawConfig, channelKey: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[channelKey] as ChannelSectionBase | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) {
    return true;
  }
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return true;
  }
  return channelHasAccounts(params.cfg, params.channelKey);
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionBase) : undefined;
  const useAccounts = shouldStoreNameInAccounts({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const safeBase = base ?? {};
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed,
        },
      },
    } as OpenClawConfig;
  }
  const baseAccounts: Record<string, Record<string, unknown>> = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...baseWithoutName,
        accounts: {
          ...baseAccounts,
          [accountId]: {
            ...existingAccount,
            name: trimmed,
          },
        },
      },
    },
  } as OpenClawConfig;
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.channelKey] as ChannelSectionBase | undefined;
  const baseName = base?.name?.trim();
  if (!baseName) {
    return params.cfg;
  }
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...rest,
        accounts,
      },
    },
  } as OpenClawConfig;
}

export function prepareScopedSetupConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
  migrateBaseName?: boolean;
}): OpenClawConfig {
  const namedConfig = applyAccountNameToChannelSection({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId: params.accountId,
    name: params.name,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
  if (!params.migrateBaseName || normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID) {
    return namedConfig;
  }
  return migrateBaseNameToDefaultAccount({
    cfg: namedConfig,
    channelKey: params.channelKey,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
}

export function applySetupAccountConfigPatch(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId: params.accountId,
    patch: params.patch,
  });
}

export function createPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter {
  return {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      prepareScopedSetupConfig({
        cfg,
        channelKey: params.channelKey,
        accountId,
        name,
        alwaysUseAccounts: params.alwaysUseAccounts,
      }),
    validateInput: params.validateInput,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const next = prepareScopedSetupConfig({
        cfg,
        channelKey: params.channelKey,
        accountId,
        name: input.name,
        alwaysUseAccounts: params.alwaysUseAccounts,
        migrateBaseName: !params.alwaysUseAccounts,
      });
      const patch = params.buildPatch(input);
      return patchScopedAccountConfig({
        cfg: next,
        channelKey: params.channelKey,
        accountId,
        patch,
        accountPatch: patch,
        ensureChannelEnabled: params.ensureChannelEnabled ?? !params.alwaysUseAccounts,
        ensureAccountEnabled: params.ensureAccountEnabled ?? true,
        scopeDefaultToAccounts: params.alwaysUseAccounts,
      });
    },
  };
}

export function createEnvPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  defaultAccountOnlyEnvError: string;
  missingCredentialError: string;
  hasCredentials: (input: ChannelSetupInput) => boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter {
  return createPatchedAccountSetupAdapter({
    channelKey: params.channelKey,
    alwaysUseAccounts: params.alwaysUseAccounts,
    ensureChannelEnabled: params.ensureChannelEnabled,
    ensureAccountEnabled: params.ensureAccountEnabled,
    validateInput: (inputParams) => {
      if (inputParams.input.useEnv && inputParams.accountId !== DEFAULT_ACCOUNT_ID) {
        return params.defaultAccountOnlyEnvError;
      }
      if (!inputParams.input.useEnv && !params.hasCredentials(inputParams.input)) {
        return params.missingCredentialError;
      }
      return params.validateInput?.(inputParams) ?? null;
    },
    buildPatch: params.buildPatch,
  });
}

export function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
  accountPatch?: Record<string, unknown>;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channelKey];
  const base =
    typeof channelConfig === "object" && channelConfig
      ? (channelConfig as Record<string, unknown> & {
          accounts?: Record<string, Record<string, unknown>>;
        })
      : undefined;
  const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
  const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
  const patch = params.patch;
  const accountPatch = params.accountPatch ?? patch;
  if (accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...base,
          ...(ensureChannelEnabled ? { enabled: true } : {}),
          ...patch,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = base?.accounts ?? {};
  const existingAccount = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...base,
        ...(ensureChannelEnabled ? { enabled: true } : {}),
        accounts: {
          ...accounts,
          [accountId]: {
            ...existingAccount,
            ...(ensureAccountEnabled
              ? {
                  enabled:
                    typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true,
                }
              : {}),
            ...accountPatch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

type ChannelSectionRecord = Record<string, unknown> & {
  accounts?: Record<string, Record<string, unknown>>;
};

const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
  "name",
  "token",
  "tokenFile",
  "botToken",
  "appToken",
  "account",
  "signalNumber",
  "authDir",
  "cliPath",
  "dbPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "service",
  "region",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceName",
  "url",
  "code",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
]);

const SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL: Record<string, ReadonlySet<string>> = {
  matrix: new Set([
    "deviceId",
    "avatarUrl",
    "initialSyncLimit",
    "encryption",
    "allowlistOnly",
    "replyToMode",
    "threadReplies",
    "textChunkLimit",
    "chunkMode",
    "responsePrefix",
    "ackReaction",
    "ackReactionScope",
    "reactionNotifications",
    "threadBindings",
    "startupVerification",
    "startupVerificationCooldownHours",
    "mediaMaxMb",
    "autoJoin",
    "autoJoinAllowlist",
    "dm",
    "groups",
    "rooms",
    "actions",
  ]),
  telegram: new Set(["streaming"]),
};

const MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS = new Set([
  "name",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceId",
  "deviceName",
  "avatarUrl",
  "initialSyncLimit",
  "encryption",
]);

export const MATRIX_SHARED_MULTI_ACCOUNT_DEFAULT_KEYS = new Set([
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "allowlistOnly",
  "replyToMode",
  "threadReplies",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "ackReaction",
  "ackReactionScope",
  "reactionNotifications",
  "threadBindings",
  "startupVerification",
  "startupVerificationCooldownHours",
  "mediaMaxMb",
  "autoJoin",
  "autoJoinAllowlist",
  "dm",
  "groups",
  "rooms",
  "actions",
]);

export function shouldMoveSingleAccountChannelKey(params: {
  channelKey: string;
  key: string;
}): boolean {
  if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(params.key)) {
    return true;
  }
  return SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL[params.channelKey]?.has(params.key) ?? false;
}

export function resolveSingleAccountKeysToMove(params: {
  channelKey: string;
  channel: Record<string, unknown>;
}): string[] {
  const hasNamedAccounts =
    Object.keys((params.channel.accounts as Record<string, unknown>) ?? {}).filter(Boolean).length >
    0;
  return Object.entries(params.channel)
    .filter(([key, value]) => {
      if (key === "accounts" || key === "enabled" || value === undefined) {
        return false;
      }
      if (!shouldMoveSingleAccountChannelKey({ channelKey: params.channelKey, key })) {
        return false;
      }
      if (
        params.channelKey === "matrix" &&
        hasNamedAccounts &&
        !MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS.has(key)
      ) {
        return false;
      }
      return true;
    })
    .map(([key]) => key);
}

export function resolveSingleAccountPromotionTarget(params: {
  channelKey: string;
  channel: ChannelSectionBase;
}): string {
  if (params.channelKey !== "matrix") {
    return DEFAULT_ACCOUNT_ID;
  }
  const accounts = params.channel.accounts ?? {};
  const normalizedDefaultAccount =
    typeof params.channel.defaultAccount === "string" && params.channel.defaultAccount.trim()
      ? normalizeAccountId(params.channel.defaultAccount)
      : undefined;
  if (normalizedDefaultAccount) {
    if (normalizedDefaultAccount !== DEFAULT_ACCOUNT_ID) {
      const matchedAccountId = Object.entries(accounts).find(
        ([accountId, value]) =>
          accountId &&
          value &&
          typeof value === "object" &&
          normalizeAccountId(accountId) === normalizedDefaultAccount,
      )?.[0];
      if (matchedAccountId) {
        return matchedAccountId;
      }
    }
    return DEFAULT_ACCOUNT_ID;
  }
  const namedAccounts = Object.entries(accounts).filter(
    ([accountId, value]) => accountId && typeof value === "object" && value,
  );
  if (namedAccounts.length === 1) {
    return namedAccounts[0][0];
  }
  if (
    namedAccounts.length > 1 &&
    accounts[DEFAULT_ACCOUNT_ID] &&
    typeof accounts[DEFAULT_ACCOUNT_ID] === "object"
  ) {
    return DEFAULT_ACCOUNT_ID;
  }
  return DEFAULT_ACCOUNT_ID;
}

function cloneIfObject<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

// When promoting a single-account channel config to multi-account,
// move top-level account settings into accounts.default so the original
// account keeps working without duplicate account values at channel root.
export function moveSingleAccountChannelSectionToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionRecord) : undefined;
  if (!base) {
    return params.cfg;
  }

  const accounts = base.accounts ?? {};
  if (Object.keys(accounts).length > 0) {
    if (params.channelKey !== "matrix") {
      return params.cfg;
    }
    const keysToMove = resolveSingleAccountKeysToMove({
      channelKey: params.channelKey,
      channel: base,
    });
    if (keysToMove.length === 0) {
      return params.cfg;
    }

    const targetAccountId = resolveSingleAccountPromotionTarget({
      channelKey: params.channelKey,
      channel: base,
    });
    const defaultAccount: Record<string, unknown> = {
      ...accounts[targetAccountId],
    };
    for (const key of keysToMove) {
      const value = base[key];
      defaultAccount[key] = cloneIfObject(value);
    }
    const nextChannel: ChannelSectionRecord = { ...base };
    for (const key of keysToMove) {
      delete nextChannel[key];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...nextChannel,
          accounts: {
            ...accounts,
            [targetAccountId]: defaultAccount,
          },
        },
      },
    } as OpenClawConfig;
  }
  const keysToMove = resolveSingleAccountKeysToMove({
    channelKey: params.channelKey,
    channel: base,
  });
  const defaultAccount: Record<string, unknown> = {};
  for (const key of keysToMove) {
    const value = base[key];
    defaultAccount[key] = cloneIfObject(value);
  }
  const nextChannel: ChannelSectionRecord = { ...base };
  for (const key of keysToMove) {
    delete nextChannel[key];
  }

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...nextChannel,
        accounts: {
          ...accounts,
          [DEFAULT_ACCOUNT_ID]: defaultAccount,
        },
      },
    },
  } as OpenClawConfig;
}
