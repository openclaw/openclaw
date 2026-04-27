import { DEFAULT_SECRET_PROVIDER_ALIAS, hasConfiguredSecretInput, normalizeSecretInputString, } from "../config/types.secrets.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProviders } from "../plugins/web-search-providers.shared.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sortFlowContributionsByLabel } from "./types.js";
function resolveSearchProviderCredentialLabel(entry) {
    if (entry.requiresCredential === false) {
        return `${entry.label} setup`;
    }
    return normalizeOptionalString(entry.credentialLabel) || `${entry.label} API key`;
}
export function listSearchProviderOptions(config) {
    return resolveSearchProviderOptions(config);
}
function showsSearchProviderInSetup(entry) {
    return entry.onboardingScopes?.includes("text-inference") ?? false;
}
export function resolveSearchProviderOptions(config) {
    return resolveSearchProviderSetupContributions(config).map((contribution) => contribution.provider);
}
function buildSearchProviderSetupContribution(params) {
    return {
        id: `search:setup:${params.provider.id}`,
        kind: "search",
        surface: "setup",
        provider: params.provider,
        option: {
            value: params.provider.id,
            label: params.provider.label,
            ...(params.provider.hint ? { hint: params.provider.hint } : {}),
            ...(params.provider.docsUrl ? { docs: { path: params.provider.docsUrl } } : {}),
        },
        source: params.source,
    };
}
export function resolveSearchProviderSetupContributions(config) {
    const providers = sortWebSearchProviders(resolvePluginWebSearchProviders({
        config,
        env: process.env,
        mode: "setup",
    }));
    return sortFlowContributionsByLabel(providers
        .filter(showsSearchProviderInSetup)
        .map((provider) => buildSearchProviderSetupContribution({ provider, source: "runtime" })));
}
function resolveSearchProviderEntry(config, provider) {
    return resolveSearchProviderOptions(config).find((entry) => entry.id === provider);
}
export function hasKeyInEnv(entry) {
    return entry.envVars.some((k) => Boolean(normalizeOptionalString(process.env[k])));
}
function providerNeedsCredential(entry) {
    return entry.requiresCredential !== false;
}
function providerIsReady(config, entry) {
    if (!providerNeedsCredential(entry)) {
        return true;
    }
    return hasExistingKey(config, entry.id) || hasKeyInEnv(entry);
}
function rawKeyValue(config, provider) {
    const entry = resolveSearchProviderEntry(config, provider);
    return entry?.getConfiguredCredentialValue?.(config);
}
export function resolveExistingKey(config, provider) {
    return normalizeSecretInputString(rawKeyValue(config, provider));
}
export function hasExistingKey(config, provider) {
    return hasConfiguredSecretInput(rawKeyValue(config, provider));
}
function buildSearchEnvRef(config, provider) {
    const entry = resolveSearchProviderEntry(config, provider) ??
        listSearchProviderOptions(config).find((candidate) => candidate.id === provider) ??
        listSearchProviderOptions().find((candidate) => candidate.id === provider);
    const resolvedEnvVar = entry?.envVars.find((k) => Boolean(normalizeOptionalString(process.env[k]))) ??
        entry?.envVars[0];
    if (!resolvedEnvVar) {
        throw new Error(`No env var mapping for search provider "${provider}" at ${entry?.credentialPath ?? "unknown path"} in secret-input-mode=ref.`);
    }
    return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: resolvedEnvVar };
}
function resolveSearchSecretInput(config, provider, key, secretInputMode) {
    const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
    if (useSecretRefMode) {
        return buildSearchEnvRef(config, provider);
    }
    return key;
}
export function applySearchKey(config, provider, key) {
    const providerEntry = resolveSearchProviderEntry(config, provider);
    if (!providerEntry) {
        return config;
    }
    const search = { ...config.tools?.web?.search, provider, enabled: true };
    if (!providerEntry.setConfiguredCredentialValue) {
        providerEntry.setCredentialValue(search, key);
    }
    const nextBase = {
        ...config,
        tools: {
            ...config.tools,
            web: { ...config.tools?.web, search },
        },
    };
    const next = applySearchProviderSelectionConfig(nextBase, providerEntry);
    providerEntry.setConfiguredCredentialValue?.(next, key);
    return next;
}
function applySearchProviderSelectionConfig(config, providerEntry) {
    if (providerEntry.applySelectionConfig) {
        return providerEntry.applySelectionConfig(config);
    }
    if (providerEntry.pluginId) {
        return enablePluginInConfig(config, providerEntry.pluginId).config;
    }
    return config;
}
export function applySearchProviderSelection(config, provider) {
    const providerEntry = resolveSearchProviderEntry(config, provider);
    if (!providerEntry) {
        return config;
    }
    const search = {
        ...config.tools?.web?.search,
        provider,
        enabled: true,
    };
    const nextBase = {
        ...config,
        tools: {
            ...config.tools,
            web: {
                ...config.tools?.web,
                search,
            },
        },
    };
    return applySearchProviderSelectionConfig(nextBase, providerEntry);
}
function preserveDisabledState(original, result) {
    if (original.tools?.web?.search?.enabled !== false) {
        return result;
    }
    const next = {
        ...result,
        tools: {
            ...result.tools,
            web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
        },
    };
    const provider = next.tools?.web?.search?.provider;
    if (typeof provider !== "string") {
        return next;
    }
    const providerEntry = resolveSearchProviderEntry(original, provider);
    if (!providerEntry?.pluginId) {
        return next;
    }
    const pluginId = providerEntry.pluginId;
    const originalPluginEntry = original.plugins?.entries?.[pluginId];
    const resultPluginEntry = next.plugins?.entries?.[pluginId];
    const nextPlugins = { ...next.plugins };
    if (Array.isArray(original.plugins?.allow)) {
        nextPlugins.allow = [...original.plugins.allow];
    }
    else {
        delete nextPlugins.allow;
    }
    if (resultPluginEntry || originalPluginEntry) {
        const nextEntries = {
            ...nextPlugins.entries,
        };
        const patchedEntry = { ...resultPluginEntry };
        if (typeof originalPluginEntry?.enabled === "boolean") {
            patchedEntry.enabled = originalPluginEntry.enabled;
        }
        else {
            delete patchedEntry.enabled;
        }
        nextEntries[pluginId] = patchedEntry;
        nextPlugins.entries = nextEntries;
    }
    return {
        ...next,
        plugins: nextPlugins,
    };
}
async function finalizeSearchProviderSetup(params) {
    let next = preserveDisabledState(params.originalConfig, params.nextConfig);
    if (!params.entry.runSetup) {
        return next;
    }
    next = await params.entry.runSetup({
        config: next,
        runtime: params.runtime,
        prompter: params.prompter,
        quickstartDefaults: params.opts?.quickstartDefaults,
        secretInputMode: params.opts?.secretInputMode,
    });
    return preserveDisabledState(params.originalConfig, next);
}
export async function runSearchSetupFlow(config, runtime, prompter, opts) {
    const providerOptions = resolveSearchProviderOptions(config);
    if (providerOptions.length === 0) {
        await prompter.note([
            "No web search providers are currently available under this plugin policy.",
            "Enable plugins or remove deny rules, then run setup again.",
            "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"), "Web search");
        return config;
    }
    await prompter.note([
        "Web search lets your agent look things up online.",
        "Choose a provider. Some providers need an API key, and some work key-free.",
        "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"), "Web search");
    const existingProvider = config.tools?.web?.search?.provider;
    const options = providerOptions.map((entry) => {
        const hint = entry.requiresCredential === false
            ? `${entry.hint} · key-free`
            : providerIsReady(config, entry)
                ? `${entry.hint} · configured`
                : entry.hint;
        return { value: entry.id, label: entry.label, hint };
    });
    const defaultProvider = (() => {
        if (existingProvider && providerOptions.some((entry) => entry.id === existingProvider)) {
            return existingProvider;
        }
        const detected = providerOptions.find((entry) => providerIsReady(config, entry));
        if (detected) {
            return detected.id;
        }
        return providerOptions[0].id;
    })();
    const choice = await prompter.select({
        message: "Search provider",
        options: [
            ...options,
            {
                value: "__skip__",
                label: "Skip for now",
                hint: "Configure later with openclaw configure --section web",
            },
        ],
        initialValue: defaultProvider,
        searchable: true,
    });
    if (choice === "__skip__") {
        return config;
    }
    const entry = resolveSearchProviderEntry(config, choice) ?? providerOptions.find((e) => e.id === choice);
    if (!entry) {
        return config;
    }
    const credentialLabel = resolveSearchProviderCredentialLabel(entry);
    const existingKey = resolveExistingKey(config, choice);
    const keyConfigured = hasExistingKey(config, choice);
    const envAvailable = hasKeyInEnv(entry);
    const needsCredential = providerNeedsCredential(entry);
    if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) {
        const result = existingKey
            ? applySearchKey(config, choice, existingKey)
            : applySearchProviderSelection(config, choice);
        return await finalizeSearchProviderSetup({
            originalConfig: config,
            nextConfig: result,
            entry,
            runtime,
            prompter,
            opts,
        });
    }
    if (!needsCredential) {
        await prompter.note([
            `${entry.label} works without an API key.`,
            "OpenClaw will enable the plugin and use it as your web_search provider.",
            `Docs: ${entry.docsUrl ?? "https://docs.openclaw.ai/tools/web"}`,
        ].join("\n"), "Web search");
        return await finalizeSearchProviderSetup({
            originalConfig: config,
            nextConfig: applySearchProviderSelection(config, choice),
            entry,
            runtime,
            prompter,
            opts,
        });
    }
    const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
    if (useSecretRefMode) {
        if (keyConfigured) {
            return await finalizeSearchProviderSetup({
                originalConfig: config,
                nextConfig: applySearchProviderSelection(config, choice),
                entry,
                runtime,
                prompter,
                opts,
            });
        }
        const ref = buildSearchEnvRef(config, choice);
        await prompter.note([
            "Secret references enabled — OpenClaw will store a reference instead of the API key.",
            `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
            ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
            "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"), "Web search");
        return await finalizeSearchProviderSetup({
            originalConfig: config,
            nextConfig: applySearchKey(config, choice, ref),
            entry,
            runtime,
            prompter,
            opts,
        });
    }
    const keyInput = await prompter.text({
        message: keyConfigured
            ? `${credentialLabel} (leave blank to keep current)`
            : envAvailable
                ? `${credentialLabel} (leave blank to use env var)`
                : credentialLabel,
        placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
    });
    const key = normalizeOptionalString(keyInput) ?? "";
    if (key) {
        const secretInput = resolveSearchSecretInput(config, choice, key, opts?.secretInputMode);
        return await finalizeSearchProviderSetup({
            originalConfig: config,
            nextConfig: applySearchKey(config, choice, secretInput),
            entry,
            runtime,
            prompter,
            opts,
        });
    }
    if (existingKey) {
        return await finalizeSearchProviderSetup({
            originalConfig: config,
            nextConfig: applySearchKey(config, choice, existingKey),
            entry,
            runtime,
            prompter,
            opts,
        });
    }
    if (keyConfigured || envAvailable) {
        return await finalizeSearchProviderSetup({
            originalConfig: config,
            nextConfig: applySearchProviderSelection(config, choice),
            entry,
            runtime,
            prompter,
            opts,
        });
    }
    await prompter.note([
        `No ${credentialLabel} stored — web_search won't work until a key is available.`,
        `Get your key at: ${entry.signupUrl}`,
        "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"), "Web search");
    const search = {
        ...config.tools?.web?.search,
        provider: choice,
    };
    return {
        ...config,
        tools: {
            ...config.tools,
            web: {
                ...config.tools?.web,
                search,
            },
        },
    };
}
