import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveChannelAccountKey,
  type ChannelAccountKeyPolicy,
} from "../../routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { hasConfiguredAccountValue } from "./account-helpers.js";
import { writeChannelSection } from "./config-helpers.js";
import {
  resolveSingleAccountPromotion,
  type ChannelSetupPromotionSurface,
} from "./setup-promotion-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";

type ChannelSectionBase = Record<string, unknown> & {
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

export function readChannelConfigSection(
  cfg: OpenClawConfig,
  channelKey: string,
): ChannelSectionBase | undefined {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.[channelKey];
  return section && typeof section === "object" ? (section as ChannelSectionBase) : undefined;
}

function resolveSetupAccountKey(
  accounts: ChannelSectionBase["accounts"],
  accountId: string,
  params: { channelKey: string; accountKeyPolicy?: ChannelAccountKeyPolicy },
): string {
  return (
    resolveChannelAccountKey(
      accounts,
      accountId,
      params.channelKey,
      (id) => id,
      params.accountKeyPolicy,
    ) ?? accountId
  );
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountKeyPolicy?: ChannelAccountKeyPolicy;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  const base = readChannelConfigSection(params.cfg, params.channelKey);
  const accounts = base?.accounts ?? {};
  const accountKey = resolveSetupAccountKey(accounts, accountId, params);
  const useAccounts =
    params.alwaysUseAccounts ||
    accountId !== DEFAULT_ACCOUNT_ID ||
    Object.keys(accounts).length > 0;
  if (!useAccounts) {
    return writeChannelSection(params.cfg, params.channelKey, { ...base, name: trimmed });
  }
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return writeChannelSection(params.cfg, params.channelKey, {
    ...baseWithoutName,
    accounts: { ...accounts, [accountKey]: { ...accounts[accountKey], name: trimmed } },
  });
}

/** Moves a root-level channel name into `accounts.default` before adding named accounts. */
export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountKeyPolicy?: ChannelAccountKeyPolicy;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const base = readChannelConfigSection(params.cfg, params.channelKey);
  const baseName = base?.name?.trim();
  if (!baseName) {
    return params.cfg;
  }
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccountKey = resolveSetupAccountKey(accounts, DEFAULT_ACCOUNT_ID, params);
  const defaultAccount = accounts[defaultAccountKey] ?? {};
  if (!defaultAccount.name) {
    accounts[defaultAccountKey] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return writeChannelSection(params.cfg, params.channelKey, { ...rest, accounts });
}

/** Applies setup-time account naming and optional root-name migration in one step. */
export function prepareScopedSetupConfig(
  params: Parameters<typeof applyAccountNameToChannelSection>[0] & { migrateBaseName?: boolean },
): OpenClawConfig {
  const namedConfig = applyAccountNameToChannelSection(params);
  if (!params.migrateBaseName || normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID) {
    return namedConfig;
  }
  return migrateBaseNameToDefaultAccount({
    ...params,
    cfg: namedConfig,
  });
}

/** Applies a setup patch using account-scoped config semantics. */
export function applySetupAccountConfigPatch(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountKeyPolicy?: ChannelAccountKeyPolicy;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchScopedAccountConfig(params);
}

/** Creates a setup adapter that turns validated setup input into an account config patch. */
export function createPatchedAccountSetupAdapter<
  Input extends { name?: string } = ChannelSetupInput,
>(params: {
  channelKey: string;
  accountKeyPolicy?: ChannelAccountKeyPolicy;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  validateInput?: ChannelSetupAdapter<Input>["validateInput"];
  buildPatch: (input: Input) => Record<string, unknown>;
}): ChannelSetupAdapter<Input> {
  return {
    accountKeyPolicy: params.accountKeyPolicy,
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      prepareScopedSetupConfig({
        cfg,
        channelKey: params.channelKey,
        accountKeyPolicy: params.accountKeyPolicy,
        accountId,
        name,
        alwaysUseAccounts: params.alwaysUseAccounts,
      }),
    validateInput: params.validateInput,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const next = prepareScopedSetupConfig({
        cfg,
        channelKey: params.channelKey,
        accountKeyPolicy: params.accountKeyPolicy,
        accountId,
        name: input.name,
        alwaysUseAccounts: params.alwaysUseAccounts,
        migrateBaseName: !params.alwaysUseAccounts,
      });
      const patch = params.buildPatch(input);
      return patchScopedAccountConfig({
        cfg: next,
        channelKey: params.channelKey,
        accountKeyPolicy: params.accountKeyPolicy,
        accountId,
        patch,
        ensureChannelEnabled: params.ensureChannelEnabled ?? !params.alwaysUseAccounts,
        ensureAccountEnabled: params.ensureAccountEnabled ?? true,
        scopeDefaultToAccounts: params.alwaysUseAccounts,
      });
    },
  };
}

type SetupInputPresenceRequirement = {
  someOf: string[];
  message: string;
};

export function createSetupInputPresenceValidator<
  Input extends { name?: string; useEnv?: boolean } = ChannelSetupInput,
>(params: {
  defaultAccountOnlyEnvError?: string;
  whenNotUseEnv?: SetupInputPresenceRequirement[];
  validate?: NonNullable<ChannelSetupAdapter<Input>["validateInput"]>;
}): NonNullable<ChannelSetupAdapter<Input>["validateInput"]> {
  return (inputParams) => {
    if (
      params.defaultAccountOnlyEnvError &&
      inputParams.input.useEnv &&
      inputParams.accountId !== DEFAULT_ACCOUNT_ID
    ) {
      return params.defaultAccountOnlyEnvError;
    }
    if (!inputParams.input.useEnv) {
      const inputRecord = inputParams.input as Record<string, unknown>;
      for (const requirement of params.whenNotUseEnv ?? []) {
        if (requirement.someOf.some((key) => hasConfiguredAccountValue(inputRecord[key]))) {
          continue;
        }
        return requirement.message;
      }
    }
    return params.validate?.(inputParams) ?? null;
  };
}

/** Creates a setup adapter that supports env-backed default account auth and patched credentials. */
export function createEnvPatchedAccountSetupAdapter(
  params: Parameters<typeof createPatchedAccountSetupAdapter<ChannelSetupInput>>[0] & {
    defaultAccountOnlyEnvError: string;
    missingCredentialError: string;
    hasCredentials: (input: ChannelSetupInput) => boolean;
  },
): ChannelSetupAdapter {
  return createPatchedAccountSetupAdapter({
    ...params,
    validateInput: (inputParams) => {
      if (inputParams.input.useEnv && inputParams.accountId !== DEFAULT_ACCOUNT_ID) {
        return params.defaultAccountOnlyEnvError;
      }
      if (!inputParams.input.useEnv && !params.hasCredentials(inputParams.input)) {
        return params.missingCredentialError;
      }
      return params.validateInput?.(inputParams) ?? null;
    },
  });
}

/** Patches channel config at root for default accounts or under `accounts.<id>` for named accounts. */
export function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountKeyPolicy?: ChannelAccountKeyPolicy;
  accountId: string;
  patch: Record<string, unknown>;
  accountPatch?: Record<string, unknown>;
  clearFields?: readonly string[];
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const base = readChannelConfigSection(params.cfg, params.channelKey);
  const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
  const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
  const patch = params.patch;
  const accountPatch = params.accountPatch ?? patch;
  const clearFields = (record: Record<string, unknown>): Record<string, unknown> => {
    if (!params.clearFields?.length) {
      return record;
    }
    const cleared = { ...record };
    for (const field of params.clearFields) {
      delete cleared[field];
    }
    return cleared;
  };
  if (accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccounts) {
    // Default accounts historically live at channel root unless the channel opts into accounts.default.
    return writeChannelSection(params.cfg, params.channelKey, {
      ...clearFields(base ?? {}),
      ...(ensureChannelEnabled ? { enabled: true } : {}),
      ...patch,
    });
  }

  const accounts = base?.accounts ?? {};
  const accountKey = resolveSetupAccountKey(accounts, accountId, params);
  const existingAccount = clearFields(accounts[accountKey] ?? {});
  // Preserve an explicit disabled account while enabling newly created accounts by default.
  return writeChannelSection(params.cfg, params.channelKey, {
    ...base,
    ...(ensureChannelEnabled ? { enabled: true } : {}),
    accounts: {
      ...accounts,
      [accountKey]: {
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
  });
}

function resolveSingleAccountPromotionTarget(params: {
  channelKey: string;
  channel: ChannelSectionBase;
  setupSurface?: ChannelSetupPromotionSurface;
}): string {
  const accounts = params.channel.accounts ?? {};
  const resolveTargetKey = (accountId: string) =>
    resolveChannelAccountKey(
      accounts,
      normalizeAccountId(accountId),
      params.channelKey,
      normalizeAccountId,
      params.setupSurface?.accountKeyPolicy,
    );
  const pluginTarget = params.setupSurface?.resolveSingleAccountPromotionTarget?.({
    channel: params.channel,
  });
  // Explicit plugin targets may create an account; inferred targets must already be eligible.
  if (pluginTarget?.trim()) {
    return resolveTargetKey(pluginTarget) ?? normalizeAccountId(pluginTarget);
  }
  const normalizedDefaultAccount =
    typeof params.channel.defaultAccount === "string" && params.channel.defaultAccount.trim()
      ? normalizeAccountId(params.channel.defaultAccount)
      : undefined;
  const namedAccounts = Object.keys(accounts).filter(Boolean);
  const targetAccountId =
    normalizedDefaultAccount ??
    (namedAccounts.length === 1 ? (namedAccounts[0] ?? DEFAULT_ACCOUNT_ID) : DEFAULT_ACCOUNT_ID);
  return (
    resolveTargetKey(targetAccountId) ?? resolveTargetKey(DEFAULT_ACCOUNT_ID) ?? DEFAULT_ACCOUNT_ID
  );
}

/**
 * Promotes legacy single-account channel fields into the account map for multi-account setup.
 */
export function moveSingleAccountChannelSectionToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  setupSurface?: ChannelSetupAdapter | ChannelSetupPromotionSurface;
}): OpenClawConfig {
  const base = readChannelConfigSection(params.cfg, params.channelKey);
  if (!base) {
    return params.cfg;
  }

  const accounts = base.accounts ?? {};
  const hasAccounts = Object.keys(accounts).length > 0;
  const promotion = resolveSingleAccountPromotion({
    channelKey: params.channelKey,
    channel: base,
    setupSurface: params.setupSurface,
    includeSetupKeys: true,
  });
  if (promotion.kind === "preserve-root") {
    return params.cfg;
  }
  const { keysToMove } = promotion;
  // Preserve the default identity for env-only single-account configurations.
  if (hasAccounts && keysToMove.length === 0) {
    return params.cfg;
  }
  const targetAccountKey = hasAccounts
    ? resolveSingleAccountPromotionTarget({
        channel: base,
        channelKey: params.channelKey,
        setupSurface: params.setupSurface,
      })
    : DEFAULT_ACCOUNT_ID;
  const nextAccount: Record<string, unknown> = { ...accounts[targetAccountKey] };
  const nextChannel = { ...base };
  for (const key of keysToMove) {
    if (!(key in nextAccount)) {
      const value = base[key];
      nextAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
    }
    delete nextChannel[key];
  }
  return writeChannelSection(params.cfg, params.channelKey, {
    ...nextChannel,
    accounts: { ...accounts, [targetAccountKey]: nextAccount },
  });
}
