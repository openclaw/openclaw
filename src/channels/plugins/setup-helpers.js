import { z } from "zod";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { resolveSingleAccountKeysToMove, resolveSingleAccountPromotionTarget, } from "./setup-promotion-helpers.js";
function channelHasAccounts(cfg, channelKey) {
    const channels = cfg.channels;
    const base = channels?.[channelKey];
    return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
    if (params.alwaysUseAccounts) {
        return true;
    }
    if (params.accountId !== DEFAULT_ACCOUNT_ID) {
        return true;
    }
    return channelHasAccounts(params.cfg, params.channelKey);
}
export function applyAccountNameToChannelSection(params) {
    const trimmed = params.name?.trim();
    if (!trimmed) {
        return params.cfg;
    }
    const accountId = normalizeAccountId(params.accountId);
    const channels = params.cfg.channels;
    const baseConfig = channels?.[params.channelKey];
    const base = typeof baseConfig === "object" && baseConfig ? baseConfig : undefined;
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
        };
    }
    const baseAccounts = base?.accounts ?? {};
    const existingAccount = baseAccounts[accountId] ?? {};
    const baseWithoutName = accountId === DEFAULT_ACCOUNT_ID
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
    };
}
export function migrateBaseNameToDefaultAccount(params) {
    if (params.alwaysUseAccounts) {
        return params.cfg;
    }
    const channels = params.cfg.channels;
    const base = channels?.[params.channelKey];
    const baseName = base?.name?.trim();
    if (!baseName) {
        return params.cfg;
    }
    const accounts = {
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
    };
}
export function prepareScopedSetupConfig(params) {
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
export function clearSetupPromotionRuntimeModuleCache() { }
export function applySetupAccountConfigPatch(params) {
    return patchScopedAccountConfig({
        cfg: params.cfg,
        channelKey: params.channelKey,
        accountId: params.accountId,
        patch: params.patch,
    });
}
export function createPatchedAccountSetupAdapter(params) {
    return {
        resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
        applyAccountName: ({ cfg, accountId, name }) => prepareScopedSetupConfig({
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
export function createZodSetupInputValidator(params) {
    return (inputParams) => {
        const parsed = params.schema.safeParse(inputParams.input);
        if (!parsed.success) {
            return parsed.error.issues[0]?.message ?? "invalid input";
        }
        return (params.validate?.({
            ...inputParams,
            input: parsed.data,
        }) ?? null);
    };
}
const GenericSetupInputSchema = z
    .object({
    useEnv: z.boolean().optional(),
})
    .passthrough();
function hasPresentSetupValue(value) {
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    return value !== undefined && value !== null;
}
export function createSetupInputPresenceValidator(params) {
    return createZodSetupInputValidator({
        schema: GenericSetupInputSchema,
        validate: (inputParams) => {
            if (params.defaultAccountOnlyEnvError &&
                inputParams.input.useEnv &&
                inputParams.accountId !== DEFAULT_ACCOUNT_ID) {
                return params.defaultAccountOnlyEnvError;
            }
            if (!inputParams.input.useEnv) {
                const inputRecord = inputParams.input;
                for (const requirement of params.whenNotUseEnv ?? []) {
                    if (requirement.someOf.some((key) => hasPresentSetupValue(inputRecord[key]))) {
                        continue;
                    }
                    return requirement.message;
                }
            }
            return params.validate?.(inputParams) ?? null;
        },
    });
}
export function createEnvPatchedAccountSetupAdapter(params) {
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
export function patchScopedAccountConfig(params) {
    const accountId = normalizeAccountId(params.accountId);
    const channels = params.cfg.channels;
    const channelConfig = channels?.[params.channelKey];
    const base = typeof channelConfig === "object" && channelConfig
        ? channelConfig
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
        };
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
                                enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true,
                            }
                            : {}),
                        ...accountPatch,
                    },
                },
            },
        },
    };
}
function cloneIfObject(value) {
    if (value && typeof value === "object") {
        return structuredClone(value);
    }
    return value;
}
function moveSingleAccountKeysIntoAccount(params) {
    const nextAccount = { ...params.baseAccount };
    for (const key of params.keysToMove) {
        nextAccount[key] = cloneIfObject(params.channel[key]);
    }
    const nextChannel = { ...params.channel };
    for (const key of params.keysToMove) {
        delete nextChannel[key];
    }
    return {
        ...params.cfg,
        channels: {
            ...params.cfg.channels,
            [params.channelKey]: {
                ...nextChannel,
                accounts: {
                    ...params.accounts,
                    [params.targetAccountId]: nextAccount,
                },
            },
        },
    };
}
function resolveExistingAccountKey(accounts, targetAccountId) {
    for (const existingKey of Object.keys(accounts)) {
        if (normalizeAccountId(existingKey) === targetAccountId) {
            return existingKey;
        }
    }
    return targetAccountId;
}
// When promoting a single-account channel config to multi-account,
// move top-level account settings into accounts.default so the original
// account keeps working without duplicate account values at channel root.
export function moveSingleAccountChannelSectionToDefaultAccount(params) {
    const channels = params.cfg.channels;
    const baseConfig = channels?.[params.channelKey];
    const base = typeof baseConfig === "object" && baseConfig ? baseConfig : undefined;
    if (!base) {
        return params.cfg;
    }
    const accounts = base.accounts ?? {};
    if (Object.keys(accounts).length > 0) {
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
        const resolvedTargetAccountKey = resolveExistingAccountKey(accounts, targetAccountId);
        return moveSingleAccountKeysIntoAccount({
            cfg: params.cfg,
            channelKey: params.channelKey,
            channel: base,
            accounts,
            keysToMove,
            targetAccountId: resolvedTargetAccountKey,
            baseAccount: accounts[resolvedTargetAccountKey],
        });
    }
    const keysToMove = resolveSingleAccountKeysToMove({
        channelKey: params.channelKey,
        channel: base,
    });
    return moveSingleAccountKeysIntoAccount({
        cfg: params.cfg,
        channelKey: params.channelKey,
        channel: base,
        accounts,
        keysToMove,
        targetAccountId: DEFAULT_ACCOUNT_ID,
    });
}
