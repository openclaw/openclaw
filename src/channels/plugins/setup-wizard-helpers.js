import { resolveSecretInputModeForEnvSelection } from "../../plugins/provider-auth-mode.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { moveSingleAccountChannelSectionToDefaultAccount, patchScopedAccountConfig, } from "./setup-helpers.js";
let providerAuthInputPromise;
function loadProviderAuthInput() {
    providerAuthInputPromise ??= import("../../plugins/provider-auth-ref.js");
    return providerAuthInputPromise;
}
export const promptAccountId = async (params) => {
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
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
    });
    const normalized = normalizeAccountId(entered);
    if ((normalizeOptionalString(entered) ?? "") !== normalized) {
        await params.prompter.note(`Normalized account id to "${normalized}".`, `${params.label} account`);
    }
    return normalized;
};
export function addWildcardAllowFrom(allowFrom) {
    const next = normalizeStringEntries(allowFrom ?? []);
    if (!next.includes("*")) {
        next.push("*");
    }
    return next;
}
export function mergeAllowFromEntries(current, additions) {
    const merged = normalizeStringEntries([...(current ?? []), ...additions]);
    return [...new Set(merged)];
}
export function splitSetupEntries(raw) {
    return raw
        .split(/[\n,;]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
export function parseSetupEntriesWithParser(raw, parseEntry) {
    const parts = splitSetupEntries(raw);
    const entries = [];
    for (const part of parts) {
        const parsed = parseEntry(part);
        if ("error" in parsed) {
            return { entries: [], error: parsed.error };
        }
        entries.push(parsed.value);
    }
    return { entries: normalizeAllowFromEntries(entries) };
}
export function parseSetupEntriesAllowingWildcard(raw, parseEntry) {
    return parseSetupEntriesWithParser(raw, (entry) => {
        if (entry === "*") {
            return { value: "*" };
        }
        return parseEntry(entry);
    });
}
export function parseMentionOrPrefixedId(params) {
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
export function normalizeAllowFromEntries(entries, normalizeEntry) {
    const normalized = normalizeStringEntries(entries)
        .map((entry) => {
        if (entry === "*") {
            return "*";
        }
        if (!normalizeEntry) {
            return entry;
        }
        return normalizeOptionalString(normalizeEntry(entry)) ?? "";
    })
        .filter(Boolean);
    return [...new Set(normalized)];
}
export function createStandardChannelSetupStatus(params) {
    const status = {
        configuredLabel: params.configuredLabel,
        unconfiguredLabel: params.unconfiguredLabel,
        resolveConfigured: params.resolveConfigured,
        ...(params.configuredHint ? { configuredHint: params.configuredHint } : {}),
        ...(params.unconfiguredHint ? { unconfiguredHint: params.unconfiguredHint } : {}),
        ...(typeof params.configuredScore === "number"
            ? { configuredScore: params.configuredScore }
            : {}),
        ...(typeof params.unconfiguredScore === "number"
            ? { unconfiguredScore: params.unconfiguredScore }
            : {}),
    };
    if (params.includeStatusLine || params.resolveExtraStatusLines) {
        status.resolveStatusLines = async ({ cfg, accountId, configured }) => {
            const lines = params.includeStatusLine
                ? [
                    `${params.channelLabel}: ${configured ? params.configuredLabel : params.unconfiguredLabel}`,
                ]
                : [];
            const extraLines = (await params.resolveExtraStatusLines?.({ cfg, accountId, configured })) ?? [];
            return [...lines, ...extraLines];
        };
    }
    return status;
}
export function resolveSetupAccountId(params) {
    return params.accountId?.trim() ? normalizeAccountId(params.accountId) : params.defaultAccountId;
}
export async function resolveAccountIdForConfigure(params) {
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
export function setAccountAllowFromForChannel(params) {
    const { cfg, channel, accountId, allowFrom } = params;
    return patchConfigForScopedAccount({
        cfg,
        channel,
        accountId,
        patch: { allowFrom },
        ensureEnabled: false,
    });
}
export function patchTopLevelChannelConfigSection(params) {
    const channelConfig = {
        ...params.cfg.channels?.[params.channel],
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
export function patchNestedChannelConfigSection(params) {
    const channelConfig = {
        ...params.cfg.channels?.[params.channel],
    };
    const sectionConfig = {
        ...channelConfig[params.section],
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
export function setTopLevelChannelAllowFrom(params) {
    return patchTopLevelChannelConfigSection({
        cfg: params.cfg,
        channel: params.channel,
        enabled: params.enabled,
        patch: { allowFrom: params.allowFrom },
    });
}
export function setNestedChannelAllowFrom(params) {
    return patchNestedChannelConfigSection({
        cfg: params.cfg,
        channel: params.channel,
        section: params.section,
        enabled: params.enabled,
        patch: { allowFrom: params.allowFrom },
    });
}
export function setTopLevelChannelDmPolicyWithAllowFrom(params) {
    const channelConfig = params.cfg.channels?.[params.channel] ?? {};
    const existingAllowFrom = params.getAllowFrom?.(params.cfg) ??
        channelConfig.allowFrom ??
        undefined;
    const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
    return patchTopLevelChannelConfigSection({
        cfg: params.cfg,
        channel: params.channel,
        patch: {
            dmPolicy: params.dmPolicy,
            ...(allowFrom ? { allowFrom } : {}),
        },
    });
}
export function setNestedChannelDmPolicyWithAllowFrom(params) {
    const channelConfig = params.cfg.channels?.[params.channel] ?? {};
    const sectionConfig = channelConfig[params.section] ?? {};
    const existingAllowFrom = params.getAllowFrom?.(params.cfg) ??
        sectionConfig.allowFrom ??
        undefined;
    const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
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
export function setTopLevelChannelGroupPolicy(params) {
    return patchTopLevelChannelConfigSection({
        cfg: params.cfg,
        channel: params.channel,
        enabled: params.enabled,
        patch: { groupPolicy: params.groupPolicy },
    });
}
export function createTopLevelChannelDmPolicy(params) {
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
export function createNestedChannelDmPolicy(params) {
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
export function createTopLevelChannelDmPolicySetter(params) {
    return (cfg, dmPolicy) => setTopLevelChannelDmPolicyWithAllowFrom({
        cfg,
        channel: params.channel,
        dmPolicy,
        getAllowFrom: params.getAllowFrom,
    });
}
export function createNestedChannelDmPolicySetter(params) {
    return (cfg, dmPolicy) => setNestedChannelDmPolicyWithAllowFrom({
        cfg,
        channel: params.channel,
        section: params.section,
        dmPolicy,
        getAllowFrom: params.getAllowFrom,
        enabled: params.enabled,
    });
}
export function createTopLevelChannelAllowFromSetter(params) {
    return (cfg, allowFrom) => setTopLevelChannelAllowFrom({
        cfg,
        channel: params.channel,
        allowFrom,
        enabled: params.enabled,
    });
}
export function createNestedChannelAllowFromSetter(params) {
    return (cfg, allowFrom) => setNestedChannelAllowFrom({
        cfg,
        channel: params.channel,
        section: params.section,
        allowFrom,
        enabled: params.enabled,
    });
}
export function createTopLevelChannelGroupPolicySetter(params) {
    return (cfg, groupPolicy) => setTopLevelChannelGroupPolicy({
        cfg,
        channel: params.channel,
        groupPolicy,
        enabled: params.enabled,
    });
}
export function setChannelDmPolicyWithAllowFrom(params) {
    const { cfg, channel, dmPolicy } = params;
    const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.[channel]?.allowFrom) : undefined;
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
export function setCompatChannelDmPolicyWithAllowFrom(params) {
    const channelConfig = params.cfg.channels?.[params.channel] ?? {
        allowFrom: undefined,
        dm: undefined,
    };
    const existingAllowFrom = channelConfig.allowFrom ?? channelConfig.dm?.allowFrom;
    const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
    return patchCompatDmChannelConfig({
        cfg: params.cfg,
        channel: params.channel,
        patch: {
            dmPolicy: params.dmPolicy,
            ...(allowFrom ? { allowFrom } : {}),
        },
    });
}
export function setCompatChannelAllowFrom(params) {
    return patchCompatDmChannelConfig({
        cfg: params.cfg,
        channel: params.channel,
        patch: { allowFrom: params.allowFrom },
    });
}
export function setAccountGroupPolicyForChannel(params) {
    return patchChannelConfigForAccount({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        patch: { groupPolicy: params.groupPolicy },
    });
}
export function setAccountDmAllowFromForChannel(params) {
    return patchChannelConfigForAccount({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        patch: { dmPolicy: "allowlist", allowFrom: params.allowFrom },
    });
}
export function createCompatChannelDmPolicy(params) {
    return {
        label: params.label,
        channel: params.channel,
        policyKey: `channels.${params.channel}.dmPolicy`,
        allowFromKey: `channels.${params.channel}.allowFrom`,
        resolveConfigKeys: (_cfg, accountId) => accountId && accountId !== DEFAULT_ACCOUNT_ID
            ? {
                policyKey: `channels.${params.channel}.accounts.${accountId}.dmPolicy`,
                allowFromKey: `channels.${params.channel}.accounts.${accountId}.allowFrom`,
            }
            : {
                policyKey: `channels.${params.channel}.dmPolicy`,
                allowFromKey: `channels.${params.channel}.allowFrom`,
            },
        getCurrent: (cfg, accountId) => {
            const channelConfig = cfg.channels?.[params.channel] ?? {};
            const accountConfig = accountId && accountId !== DEFAULT_ACCOUNT_ID
                ? channelConfig.accounts?.[accountId]
                : undefined;
            return (accountConfig?.dmPolicy ??
                accountConfig?.dm?.policy ??
                channelConfig.dmPolicy ??
                channelConfig.dm?.policy ??
                "pairing");
        },
        setPolicy: (cfg, policy, accountId) => accountId && accountId !== DEFAULT_ACCOUNT_ID
            ? patchChannelConfigForAccount({
                cfg,
                channel: params.channel,
                accountId,
                patch: {
                    dmPolicy: policy,
                    ...(policy === "open"
                        ? {
                            allowFrom: addWildcardAllowFrom(cfg.channels?.[params.channel]?.accounts?.[accountId]?.allowFrom ??
                                cfg.channels?.[params.channel]?.allowFrom ??
                                cfg.channels?.[params.channel]?.accounts?.[accountId]?.dm?.allowFrom ??
                                cfg.channels?.[params.channel]?.dm?.allowFrom),
                        }
                        : {}),
                },
            })
            : setCompatChannelDmPolicyWithAllowFrom({
                cfg,
                channel: params.channel,
                dmPolicy: policy,
            }),
        ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
    };
}
export async function resolveGroupAllowlistWithLookupNotes(params) {
    try {
        return await params.resolve();
    }
    catch (error) {
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
export function createAccountScopedAllowFromSection(params) {
    return {
        ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
        ...(params.helpLines ? { helpLines: params.helpLines } : {}),
        ...(params.credentialInputKey ? { credentialInputKey: params.credentialInputKey } : {}),
        message: params.message,
        placeholder: params.placeholder,
        invalidWithoutCredentialNote: params.invalidWithoutCredentialNote,
        parseId: params.parseId,
        resolveEntries: params.resolveEntries,
        apply: ({ cfg, accountId, allowFrom }) => setAccountDmAllowFromForChannel({
            cfg,
            channel: params.channel,
            accountId,
            allowFrom,
        }),
    };
}
export function createAccountScopedGroupAccessSection(params) {
    return {
        label: params.label,
        placeholder: params.placeholder,
        ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
        ...(params.helpLines ? { helpLines: params.helpLines } : {}),
        ...(params.skipAllowlistEntries ? { skipAllowlistEntries: true } : {}),
        currentPolicy: params.currentPolicy,
        currentEntries: params.currentEntries,
        updatePrompt: params.updatePrompt,
        setPolicy: ({ cfg, accountId, policy }) => setAccountGroupPolicyForChannel({
            cfg,
            channel: params.channel,
            accountId,
            groupPolicy: policy,
        }),
        ...(params.resolveAllowlist
            ? {
                resolveAllowlist: ({ cfg, accountId, credentialValues, entries, prompter }) => resolveGroupAllowlistWithLookupNotes({
                    label: params.label,
                    prompter,
                    entries,
                    fallback: params.fallbackResolved(entries),
                    resolve: async () => await params.resolveAllowlist({
                        cfg,
                        accountId,
                        credentialValues,
                        entries,
                        prompter,
                    }),
                }),
            }
            : {}),
        applyAllowlist: ({ cfg, accountId, resolved }) => params.applyAllowlist({
            cfg,
            accountId,
            resolved: resolved,
        }),
    };
}
export function patchCompatDmChannelConfig(params) {
    const { cfg, channel, patch } = params;
    const channelConfig = cfg.channels?.[channel] ?? {};
    const dmConfig = channelConfig.dm ?? {};
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
export function setSetupChannelEnabled(cfg, channel, enabled) {
    const channelConfig = cfg.channels?.[channel] ?? {};
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
function patchConfigForScopedAccount(params) {
    const { cfg, channel, accountId, patch, ensureEnabled } = params;
    const channelConfig = cfg.channels?.[channel];
    const hasExistingAccounts = Boolean(channelConfig?.accounts && Object.keys(channelConfig.accounts).length > 0);
    const seededCfg = accountId === DEFAULT_ACCOUNT_ID || hasExistingAccounts
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
export function patchChannelConfigForAccount(params) {
    return patchConfigForScopedAccount({
        ...params,
        ensureEnabled: true,
    });
}
export function applySingleTokenPromptResult(params) {
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
export function buildSingleChannelSecretPromptState(params) {
    return {
        accountConfigured: params.accountConfigured,
        hasConfigToken: params.hasConfigToken,
        canUseEnv: params.allowEnv && Boolean(params.envValue?.trim()) && !params.hasConfigToken,
    };
}
export async function promptSingleChannelToken(params) {
    const promptToken = async () => (await params.prompter.text({
        message: params.inputPrompt,
        validate: (value) => (value?.trim() ? undefined : "Required"),
    })).trim();
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
export async function runSingleChannelSecretStep(params) {
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
            resolvedValue: normalizeOptionalString(params.envValue),
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
export async function promptSingleChannelSecretInput(params) {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
        prompter: params.prompter,
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
    const { promptSecretRefForSetup } = await loadProviderAuthInput();
    const resolved = await promptSecretRefForSetup({
        provider: params.providerHint,
        config: params.cfg,
        prompter: params.prompter,
        preferredEnvVar: params.preferredEnvVar,
        copy: {
            sourceMessage: `Where is this ${params.credentialLabel} stored?`,
            envVarPlaceholder: params.preferredEnvVar ?? "OPENCLAW_SECRET",
            envVarFormatError: 'Use an env var name like "OPENCLAW_SECRET" (uppercase letters, numbers, underscores).',
            noProvidersMessage: "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.",
        },
    });
    return {
        action: "set",
        value: resolved.ref,
        resolvedValue: resolved.resolvedValue,
    };
}
export async function promptParsedAllowFromForAccount(params) {
    const accountId = resolveSetupAccountId({
        accountId: params.accountId,
        defaultAccountId: params.defaultAccountId,
    });
    const existing = params.getExistingAllowFrom({
        cfg: params.cfg,
        accountId,
    });
    if (params.noteTitle && params.noteLines && params.noteLines.length > 0) {
        await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
    }
    const entry = await params.prompter.text({
        message: params.message,
        placeholder: params.placeholder,
        initialValue: existing[0] ? String(existing[0]) : undefined,
        validate: (value) => {
            const raw = normalizeOptionalString(value) ?? "";
            if (!raw) {
                return "Required";
            }
            return params.parseEntries(raw).error;
        },
    });
    const parsed = params.parseEntries(entry);
    const unique = params.mergeEntries?.({
        existing,
        parsed: parsed.entries,
    }) ?? mergeAllowFromEntries(undefined, parsed.entries);
    return await params.applyAllowFrom({
        cfg: params.cfg,
        accountId,
        allowFrom: unique,
    });
}
export function createPromptParsedAllowFromForAccount(params) {
    return async ({ cfg, prompter, accountId }) => await promptParsedAllowFromForAccount({
        cfg: cfg,
        accountId,
        defaultAccountId: typeof params.defaultAccountId === "function"
            ? params.defaultAccountId(cfg)
            : params.defaultAccountId,
        prompter,
        ...(params.noteTitle ? { noteTitle: params.noteTitle } : {}),
        ...(params.noteLines ? { noteLines: params.noteLines } : {}),
        message: params.message,
        placeholder: params.placeholder,
        parseEntries: params.parseEntries,
        getExistingAllowFrom: params.getExistingAllowFrom,
        ...(params.mergeEntries ? { mergeEntries: params.mergeEntries } : {}),
        applyAllowFrom: params.applyAllowFrom,
    });
}
export async function promptParsedAllowFromForScopedChannel(params) {
    return await promptParsedAllowFromForAccount({
        cfg: params.cfg,
        accountId: params.accountId,
        defaultAccountId: params.defaultAccountId,
        prompter: params.prompter,
        noteTitle: params.noteTitle,
        noteLines: params.noteLines,
        message: params.message,
        placeholder: params.placeholder,
        parseEntries: params.parseEntries,
        getExistingAllowFrom: params.getExistingAllowFrom,
        applyAllowFrom: ({ cfg, accountId, allowFrom }) => setAccountAllowFromForChannel({
            cfg,
            channel: params.channel,
            accountId,
            allowFrom,
        }),
    });
}
export function createTopLevelChannelParsedAllowFromPrompt(params) {
    const setAllowFrom = createTopLevelChannelAllowFromSetter({
        channel: params.channel,
        ...(params.enabled ? { enabled: true } : {}),
    });
    const sharedParams = {
        ...(params.noteTitle ? { noteTitle: params.noteTitle } : {}),
        ...(params.noteLines ? { noteLines: params.noteLines } : {}),
        message: params.message,
        placeholder: params.placeholder,
        parseEntries: params.parseEntries,
        getExistingAllowFrom: ({ cfg }) => params.getExistingAllowFrom?.(cfg) ??
            cfg.channels?.[params.channel]
                ?.allowFrom ??
            [],
        ...(params.mergeEntries ? { mergeEntries: params.mergeEntries } : {}),
        applyAllowFrom: ({ cfg, allowFrom }) => setAllowFrom(cfg, allowFrom),
    };
    if (typeof params.defaultAccountId === "function") {
        return createPromptParsedAllowFromForAccount({
            defaultAccountId: params.defaultAccountId,
            ...sharedParams,
        });
    }
    const defaultAccountId = params.defaultAccountId;
    return createPromptParsedAllowFromForAccount({
        defaultAccountId,
        ...sharedParams,
    });
}
export function createNestedChannelParsedAllowFromPrompt(params) {
    const setAllowFrom = createNestedChannelAllowFromSetter({
        channel: params.channel,
        section: params.section,
        ...(params.enabled ? { enabled: true } : {}),
    });
    const defaultAccountId = params.defaultAccountId;
    const sharedParams = {
        ...(params.noteTitle ? { noteTitle: params.noteTitle } : {}),
        ...(params.noteLines ? { noteLines: params.noteLines } : {}),
        message: params.message,
        placeholder: params.placeholder,
        parseEntries: params.parseEntries,
        getExistingAllowFrom: ({ cfg }) => params.getExistingAllowFrom?.(cfg) ??
            cfg.channels?.[params.channel]?.[params.section]?.allowFrom ??
            [],
        ...(params.mergeEntries ? { mergeEntries: params.mergeEntries } : {}),
        applyAllowFrom: ({ cfg, allowFrom }) => setAllowFrom(cfg, allowFrom),
    };
    if (typeof defaultAccountId === "function") {
        return createPromptParsedAllowFromForAccount({
            defaultAccountId,
            ...sharedParams,
        });
    }
    return createPromptParsedAllowFromForAccount({
        defaultAccountId,
        ...sharedParams,
    });
}
export function resolveParsedAllowFromEntries(params) {
    return params.entries.map((entry) => {
        const id = params.parseId(entry);
        return {
            input: entry,
            resolved: Boolean(id),
            id,
        };
    });
}
export function createAllowFromSection(params) {
    return {
        ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
        ...(params.helpLines ? { helpLines: params.helpLines } : {}),
        ...(params.credentialInputKey ? { credentialInputKey: params.credentialInputKey } : {}),
        message: params.message,
        placeholder: params.placeholder,
        invalidWithoutCredentialNote: params.invalidWithoutCredentialNote,
        ...(params.parseInputs ? { parseInputs: params.parseInputs } : {}),
        parseId: params.parseId,
        resolveEntries: params.resolveEntries ??
            (async ({ entries }) => resolveParsedAllowFromEntries({ entries, parseId: params.parseId })),
        apply: params.apply,
    };
}
export async function noteChannelLookupSummary(params) {
    const lines = [];
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
export async function noteChannelLookupFailure(params) {
    await params.prompter.note(`Channel lookup failed; keeping entries as typed. ${String(params.error)}`, params.label);
}
export async function resolveEntriesWithOptionalToken(params) {
    const token = params.token?.trim();
    if (!token) {
        return params.entries.map(params.buildWithoutToken);
    }
    return await params.resolveEntries({
        token,
        entries: params.entries,
    });
}
export async function promptResolvedAllowFrom(params) {
    while (true) {
        const entry = await params.prompter.text({
            message: params.message,
            placeholder: params.placeholder,
            initialValue: params.existing[0] ? String(params.existing[0]) : undefined,
            validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
        });
        const parts = params.parseInputs(entry);
        if (!params.token) {
            const ids = parts.map(params.parseId).filter(Boolean);
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
            await params.prompter.note(`Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`, params.label);
            continue;
        }
        const ids = results.map((res) => res.id);
        return mergeAllowFromEntries(params.existing, ids);
    }
}
export async function promptLegacyChannelAllowFrom(params) {
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
    return setCompatChannelAllowFrom({
        cfg: params.cfg,
        channel: params.channel,
        allowFrom: unique,
    });
}
export async function promptLegacyChannelAllowFromForAccount(params) {
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
// Backwards-compatible aliases for existing setup SDK consumers.
export const patchLegacyDmChannelConfig = patchCompatDmChannelConfig;
export const setLegacyChannelDmPolicyWithAllowFrom = setCompatChannelDmPolicyWithAllowFrom;
export const setLegacyChannelAllowFrom = setCompatChannelAllowFrom;
export const createLegacyCompatChannelDmPolicy = createCompatChannelDmPolicy;
