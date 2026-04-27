import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeModelCatalog, } from "../model-catalog/index.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";
import { normalizeManifestCommandAliases, } from "./manifest-command-aliases.js";
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
export const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
function normalizeStringListRecord(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = Object.create(null);
    for (const [key, rawValues] of Object.entries(value)) {
        const providerId = normalizeOptionalString(key) ?? "";
        if (!providerId || isBlockedObjectKey(providerId)) {
            continue;
        }
        const values = normalizeTrimmedStringList(rawValues);
        if (values.length === 0) {
            continue;
        }
        normalized[providerId] = values;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function normalizeStringRecord(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = Object.create(null);
    for (const [rawKey, rawValue] of Object.entries(value)) {
        const key = normalizeOptionalString(rawKey) ?? "";
        const value = normalizeOptionalString(rawValue) ?? "";
        if (!key || isBlockedObjectKey(key) || !value) {
            continue;
        }
        normalized[key] = value;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
const MEDIA_UNDERSTANDING_CAPABILITIES = new Set(["image", "audio", "video"]);
function normalizeMediaUnderstandingCapabilityRecord(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
        if (!MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey)) {
            continue;
        }
        const model = normalizeOptionalString(rawValue);
        if (model) {
            normalized[rawKey] = model;
        }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function normalizeMediaUnderstandingPriorityRecord(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
        if (!MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey) ||
            typeof rawValue !== "number" ||
            !Number.isFinite(rawValue)) {
            continue;
        }
        normalized[rawKey] = rawValue;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function normalizeMediaUnderstandingCapabilities(value) {
    const values = normalizeTrimmedStringList(value).filter((entry) => MEDIA_UNDERSTANDING_CAPABILITIES.has(entry));
    return values.length > 0 ? values : undefined;
}
function normalizeMediaUnderstandingNativeDocumentInputs(value) {
    const values = normalizeTrimmedStringList(value).filter((entry) => entry === "pdf");
    return values.length > 0 ? values : undefined;
}
function normalizeMediaUnderstandingProviderMetadata(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = Object.create(null);
    for (const [rawProviderId, rawMetadata] of Object.entries(value)) {
        const providerId = normalizeOptionalString(rawProviderId) ?? "";
        if (!providerId || isBlockedObjectKey(providerId) || !isRecord(rawMetadata)) {
            continue;
        }
        const capabilities = normalizeMediaUnderstandingCapabilities(rawMetadata.capabilities);
        const defaultModels = normalizeMediaUnderstandingCapabilityRecord(rawMetadata.defaultModels);
        const autoPriority = normalizeMediaUnderstandingPriorityRecord(rawMetadata.autoPriority);
        const nativeDocumentInputs = normalizeMediaUnderstandingNativeDocumentInputs(rawMetadata.nativeDocumentInputs);
        const metadata = {
            ...(capabilities ? { capabilities } : {}),
            ...(defaultModels ? { defaultModels } : {}),
            ...(autoPriority ? { autoPriority } : {}),
            ...(nativeDocumentInputs ? { nativeDocumentInputs } : {}),
        };
        if (Object.keys(metadata).length > 0) {
            normalized[providerId] = metadata;
        }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function normalizeManifestContracts(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const embeddedExtensionFactories = normalizeTrimmedStringList(value.embeddedExtensionFactories);
    const agentToolResultMiddleware = normalizeTrimmedStringList(value.agentToolResultMiddleware);
    const externalAuthProviders = normalizeTrimmedStringList(value.externalAuthProviders);
    const memoryEmbeddingProviders = normalizeTrimmedStringList(value.memoryEmbeddingProviders);
    const speechProviders = normalizeTrimmedStringList(value.speechProviders);
    const realtimeTranscriptionProviders = normalizeTrimmedStringList(value.realtimeTranscriptionProviders);
    const realtimeVoiceProviders = normalizeTrimmedStringList(value.realtimeVoiceProviders);
    const mediaUnderstandingProviders = normalizeTrimmedStringList(value.mediaUnderstandingProviders);
    const documentExtractors = normalizeTrimmedStringList(value.documentExtractors);
    const imageGenerationProviders = normalizeTrimmedStringList(value.imageGenerationProviders);
    const videoGenerationProviders = normalizeTrimmedStringList(value.videoGenerationProviders);
    const musicGenerationProviders = normalizeTrimmedStringList(value.musicGenerationProviders);
    const webContentExtractors = normalizeTrimmedStringList(value.webContentExtractors);
    const webFetchProviders = normalizeTrimmedStringList(value.webFetchProviders);
    const webSearchProviders = normalizeTrimmedStringList(value.webSearchProviders);
    const tools = normalizeTrimmedStringList(value.tools);
    const contracts = {
        ...(embeddedExtensionFactories.length > 0 ? { embeddedExtensionFactories } : {}),
        ...(agentToolResultMiddleware.length > 0 ? { agentToolResultMiddleware } : {}),
        ...(externalAuthProviders.length > 0 ? { externalAuthProviders } : {}),
        ...(memoryEmbeddingProviders.length > 0 ? { memoryEmbeddingProviders } : {}),
        ...(speechProviders.length > 0 ? { speechProviders } : {}),
        ...(realtimeTranscriptionProviders.length > 0 ? { realtimeTranscriptionProviders } : {}),
        ...(realtimeVoiceProviders.length > 0 ? { realtimeVoiceProviders } : {}),
        ...(mediaUnderstandingProviders.length > 0 ? { mediaUnderstandingProviders } : {}),
        ...(documentExtractors.length > 0 ? { documentExtractors } : {}),
        ...(imageGenerationProviders.length > 0 ? { imageGenerationProviders } : {}),
        ...(videoGenerationProviders.length > 0 ? { videoGenerationProviders } : {}),
        ...(musicGenerationProviders.length > 0 ? { musicGenerationProviders } : {}),
        ...(webContentExtractors.length > 0 ? { webContentExtractors } : {}),
        ...(webFetchProviders.length > 0 ? { webFetchProviders } : {}),
        ...(webSearchProviders.length > 0 ? { webSearchProviders } : {}),
        ...(tools.length > 0 ? { tools } : {}),
    };
    return Object.keys(contracts).length > 0 ? contracts : undefined;
}
function isManifestConfigLiteral(value) {
    return (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean");
}
function normalizeManifestDangerousConfigFlags(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const path = normalizeOptionalString(entry.path) ?? "";
        if (!path || !isManifestConfigLiteral(entry.equals)) {
            continue;
        }
        normalized.push({ path, equals: entry.equals });
    }
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeManifestSecretInputPaths(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const path = normalizeOptionalString(entry.path) ?? "";
        if (!path) {
            continue;
        }
        const expected = entry.expected === "string" ? entry.expected : undefined;
        normalized.push({
            path,
            ...(expected ? { expected } : {}),
        });
    }
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeManifestConfigContracts(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const compatibilityMigrationPaths = normalizeTrimmedStringList(value.compatibilityMigrationPaths);
    const compatibilityRuntimePaths = normalizeTrimmedStringList(value.compatibilityRuntimePaths);
    const rawSecretInputs = isRecord(value.secretInputs) ? value.secretInputs : undefined;
    const dangerousFlags = normalizeManifestDangerousConfigFlags(value.dangerousFlags);
    const secretInputPaths = rawSecretInputs
        ? normalizeManifestSecretInputPaths(rawSecretInputs.paths)
        : undefined;
    const secretInputs = secretInputPaths && secretInputPaths.length > 0
        ? {
            ...(rawSecretInputs?.bundledDefaultEnabled === true
                ? { bundledDefaultEnabled: true }
                : rawSecretInputs?.bundledDefaultEnabled === false
                    ? { bundledDefaultEnabled: false }
                    : {}),
            paths: secretInputPaths,
        }
        : undefined;
    const configContracts = {
        ...(compatibilityMigrationPaths.length > 0 ? { compatibilityMigrationPaths } : {}),
        ...(compatibilityRuntimePaths.length > 0 ? { compatibilityRuntimePaths } : {}),
        ...(dangerousFlags ? { dangerousFlags } : {}),
        ...(secretInputs ? { secretInputs } : {}),
    };
    return Object.keys(configContracts).length > 0 ? configContracts : undefined;
}
function normalizeManifestModelSupport(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const modelPrefixes = normalizeTrimmedStringList(value.modelPrefixes);
    const modelPatterns = normalizeTrimmedStringList(value.modelPatterns);
    const modelSupport = {
        ...(modelPrefixes.length > 0 ? { modelPrefixes } : {}),
        ...(modelPatterns.length > 0 ? { modelPatterns } : {}),
    };
    return Object.keys(modelSupport).length > 0 ? modelSupport : undefined;
}
function normalizeManifestProviderEndpoints(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const endpoints = [];
    for (const rawEndpoint of value) {
        if (!isRecord(rawEndpoint)) {
            continue;
        }
        const endpointClass = normalizeOptionalString(rawEndpoint.endpointClass);
        if (!endpointClass) {
            continue;
        }
        const hosts = normalizeTrimmedStringList(rawEndpoint.hosts).map((host) => host.toLowerCase());
        const baseUrls = normalizeTrimmedStringList(rawEndpoint.baseUrls);
        if (hosts.length === 0 && baseUrls.length === 0) {
            continue;
        }
        endpoints.push({
            endpointClass,
            ...(hosts.length > 0 ? { hosts } : {}),
            ...(baseUrls.length > 0 ? { baseUrls } : {}),
        });
    }
    return endpoints.length > 0 ? endpoints : undefined;
}
function normalizeManifestActivation(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const onProviders = normalizeTrimmedStringList(value.onProviders);
    const onAgentHarnesses = normalizeTrimmedStringList(value.onAgentHarnesses);
    const onCommands = normalizeTrimmedStringList(value.onCommands);
    const onChannels = normalizeTrimmedStringList(value.onChannels);
    const onRoutes = normalizeTrimmedStringList(value.onRoutes);
    const onCapabilities = normalizeTrimmedStringList(value.onCapabilities).filter((capability) => capability === "provider" ||
        capability === "channel" ||
        capability === "tool" ||
        capability === "hook");
    const activation = {
        ...(onProviders.length > 0 ? { onProviders } : {}),
        ...(onAgentHarnesses.length > 0 ? { onAgentHarnesses } : {}),
        ...(onCommands.length > 0 ? { onCommands } : {}),
        ...(onChannels.length > 0 ? { onChannels } : {}),
        ...(onRoutes.length > 0 ? { onRoutes } : {}),
        ...(onCapabilities.length > 0 ? { onCapabilities } : {}),
    };
    return Object.keys(activation).length > 0 ? activation : undefined;
}
function normalizeManifestSetupProviders(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const id = normalizeOptionalString(entry.id) ?? "";
        if (!id) {
            continue;
        }
        const authMethods = normalizeTrimmedStringList(entry.authMethods);
        const envVars = normalizeTrimmedStringList(entry.envVars);
        normalized.push({
            id,
            ...(authMethods.length > 0 ? { authMethods } : {}),
            ...(envVars.length > 0 ? { envVars } : {}),
        });
    }
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeManifestSetup(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const providers = normalizeManifestSetupProviders(value.providers);
    const cliBackends = normalizeTrimmedStringList(value.cliBackends);
    const configMigrations = normalizeTrimmedStringList(value.configMigrations);
    const requiresRuntime = typeof value.requiresRuntime === "boolean" ? value.requiresRuntime : undefined;
    const setup = {
        ...(providers ? { providers } : {}),
        ...(cliBackends.length > 0 ? { cliBackends } : {}),
        ...(configMigrations.length > 0 ? { configMigrations } : {}),
        ...(requiresRuntime !== undefined ? { requiresRuntime } : {}),
    };
    return Object.keys(setup).length > 0 ? setup : undefined;
}
function normalizeManifestQaRunners(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const commandName = normalizeOptionalString(entry.commandName) ?? "";
        if (!commandName) {
            continue;
        }
        const description = normalizeOptionalString(entry.description) ?? "";
        normalized.push({
            commandName,
            ...(description ? { description } : {}),
        });
    }
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeProviderAuthChoices(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const provider = normalizeOptionalString(entry.provider) ?? "";
        const method = normalizeOptionalString(entry.method) ?? "";
        const choiceId = normalizeOptionalString(entry.choiceId) ?? "";
        if (!provider || !method || !choiceId) {
            continue;
        }
        const choiceLabel = normalizeOptionalString(entry.choiceLabel) ?? "";
        const choiceHint = normalizeOptionalString(entry.choiceHint) ?? "";
        const assistantPriority = typeof entry.assistantPriority === "number" && Number.isFinite(entry.assistantPriority)
            ? entry.assistantPriority
            : undefined;
        const assistantVisibility = entry.assistantVisibility === "manual-only" || entry.assistantVisibility === "visible"
            ? entry.assistantVisibility
            : undefined;
        const deprecatedChoiceIds = normalizeTrimmedStringList(entry.deprecatedChoiceIds);
        const groupId = normalizeOptionalString(entry.groupId) ?? "";
        const groupLabel = normalizeOptionalString(entry.groupLabel) ?? "";
        const groupHint = normalizeOptionalString(entry.groupHint) ?? "";
        const optionKey = normalizeOptionalString(entry.optionKey) ?? "";
        const cliFlag = normalizeOptionalString(entry.cliFlag) ?? "";
        const cliOption = normalizeOptionalString(entry.cliOption) ?? "";
        const cliDescription = normalizeOptionalString(entry.cliDescription) ?? "";
        const onboardingScopes = normalizeTrimmedStringList(entry.onboardingScopes).filter((scope) => scope === "text-inference" || scope === "image-generation");
        normalized.push({
            provider,
            method,
            choiceId,
            ...(choiceLabel ? { choiceLabel } : {}),
            ...(choiceHint ? { choiceHint } : {}),
            ...(assistantPriority !== undefined ? { assistantPriority } : {}),
            ...(assistantVisibility ? { assistantVisibility } : {}),
            ...(deprecatedChoiceIds.length > 0 ? { deprecatedChoiceIds } : {}),
            ...(groupId ? { groupId } : {}),
            ...(groupLabel ? { groupLabel } : {}),
            ...(groupHint ? { groupHint } : {}),
            ...(optionKey ? { optionKey } : {}),
            ...(cliFlag ? { cliFlag } : {}),
            ...(cliOption ? { cliOption } : {}),
            ...(cliDescription ? { cliDescription } : {}),
            ...(onboardingScopes.length > 0 ? { onboardingScopes } : {}),
        });
    }
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeChannelConfigs(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = Object.create(null);
    for (const [key, rawEntry] of Object.entries(value)) {
        const channelId = normalizeOptionalString(key) ?? "";
        if (!channelId || isBlockedObjectKey(channelId) || !isRecord(rawEntry)) {
            continue;
        }
        const schema = isRecord(rawEntry.schema) ? rawEntry.schema : null;
        if (!schema) {
            continue;
        }
        const uiHints = isRecord(rawEntry.uiHints)
            ? rawEntry.uiHints
            : undefined;
        const runtime = isRecord(rawEntry.runtime) && typeof rawEntry.runtime.safeParse === "function"
            ? rawEntry.runtime
            : undefined;
        const label = normalizeOptionalString(rawEntry.label) ?? "";
        const description = normalizeOptionalString(rawEntry.description) ?? "";
        const preferOver = normalizeTrimmedStringList(rawEntry.preferOver);
        normalized[channelId] = {
            schema,
            ...(uiHints ? { uiHints } : {}),
            ...(runtime ? { runtime } : {}),
            ...(label ? { label } : {}),
            ...(description ? { description } : {}),
            ...(preferOver.length > 0 ? { preferOver } : {}),
        };
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
export function resolvePluginManifestPath(rootDir) {
    for (const filename of PLUGIN_MANIFEST_FILENAMES) {
        const candidate = path.join(rootDir, filename);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}
function parsePluginKind(raw) {
    if (typeof raw === "string") {
        return raw;
    }
    if (Array.isArray(raw) && raw.length > 0 && raw.every((k) => typeof k === "string")) {
        return raw.length === 1 ? raw[0] : raw;
    }
    return undefined;
}
export function loadPluginManifest(rootDir, rejectHardlinks = true) {
    const manifestPath = resolvePluginManifestPath(rootDir);
    const opened = openBoundaryFileSync({
        absolutePath: manifestPath,
        rootPath: rootDir,
        boundaryLabel: "plugin root",
        maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
        rejectHardlinks,
    });
    if (!opened.ok) {
        return matchBoundaryFileOpenFailure(opened, {
            path: () => ({
                ok: false,
                error: `plugin manifest not found: ${manifestPath}`,
                manifestPath,
            }),
            fallback: (failure) => ({
                ok: false,
                error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
                manifestPath,
            }),
        });
    }
    let raw;
    try {
        raw = JSON5.parse(fs.readFileSync(opened.fd, "utf-8"));
    }
    catch (err) {
        return {
            ok: false,
            error: `failed to parse plugin manifest: ${String(err)}`,
            manifestPath,
        };
    }
    finally {
        fs.closeSync(opened.fd);
    }
    if (!isRecord(raw)) {
        return { ok: false, error: "plugin manifest must be an object", manifestPath };
    }
    const id = normalizeOptionalString(raw.id) ?? "";
    if (!id) {
        return { ok: false, error: "plugin manifest requires id", manifestPath };
    }
    const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
    if (!configSchema) {
        return { ok: false, error: "plugin manifest requires configSchema", manifestPath };
    }
    const kind = parsePluginKind(raw.kind);
    const enabledByDefault = raw.enabledByDefault === true;
    const legacyPluginIds = normalizeTrimmedStringList(raw.legacyPluginIds);
    const autoEnableWhenConfiguredProviders = normalizeTrimmedStringList(raw.autoEnableWhenConfiguredProviders);
    const name = normalizeOptionalString(raw.name);
    const description = normalizeOptionalString(raw.description);
    const version = normalizeOptionalString(raw.version);
    const channels = normalizeTrimmedStringList(raw.channels);
    const providers = normalizeTrimmedStringList(raw.providers);
    const providerDiscoveryEntry = normalizeOptionalString(raw.providerDiscoveryEntry);
    const modelSupport = normalizeManifestModelSupport(raw.modelSupport);
    const modelCatalog = normalizeModelCatalog(raw.modelCatalog, {
        ownedProviders: new Set(providers),
    });
    const providerEndpoints = normalizeManifestProviderEndpoints(raw.providerEndpoints);
    const cliBackends = normalizeTrimmedStringList(raw.cliBackends);
    const syntheticAuthRefs = normalizeTrimmedStringList(raw.syntheticAuthRefs);
    const nonSecretAuthMarkers = normalizeTrimmedStringList(raw.nonSecretAuthMarkers);
    const commandAliases = normalizeManifestCommandAliases(raw.commandAliases);
    const providerAuthEnvVars = normalizeStringListRecord(raw.providerAuthEnvVars);
    const providerAuthAliases = normalizeStringRecord(raw.providerAuthAliases);
    const channelEnvVars = normalizeStringListRecord(raw.channelEnvVars);
    const providerAuthChoices = normalizeProviderAuthChoices(raw.providerAuthChoices);
    const activation = normalizeManifestActivation(raw.activation);
    const setup = normalizeManifestSetup(raw.setup);
    const qaRunners = normalizeManifestQaRunners(raw.qaRunners);
    const skills = normalizeTrimmedStringList(raw.skills);
    const contracts = normalizeManifestContracts(raw.contracts);
    const mediaUnderstandingProviderMetadata = normalizeMediaUnderstandingProviderMetadata(raw.mediaUnderstandingProviderMetadata);
    const configContracts = normalizeManifestConfigContracts(raw.configContracts);
    const channelConfigs = normalizeChannelConfigs(raw.channelConfigs);
    let uiHints;
    if (isRecord(raw.uiHints)) {
        uiHints = raw.uiHints;
    }
    return {
        ok: true,
        manifest: {
            id,
            configSchema,
            ...(enabledByDefault ? { enabledByDefault } : {}),
            ...(legacyPluginIds.length > 0 ? { legacyPluginIds } : {}),
            ...(autoEnableWhenConfiguredProviders.length > 0
                ? { autoEnableWhenConfiguredProviders }
                : {}),
            kind,
            channels,
            providers,
            providerDiscoveryEntry,
            modelSupport,
            modelCatalog,
            providerEndpoints,
            cliBackends,
            syntheticAuthRefs,
            nonSecretAuthMarkers,
            commandAliases,
            providerAuthEnvVars,
            providerAuthAliases,
            channelEnvVars,
            providerAuthChoices,
            activation,
            setup,
            qaRunners,
            skills,
            name,
            description,
            version,
            uiHints,
            contracts,
            mediaUnderstandingProviderMetadata,
            configContracts,
            channelConfigs,
        },
        manifestPath,
    };
}
export const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
    "index.ts",
    "index.js",
    "index.mjs",
    "index.cjs",
];
export function getPackageManifestMetadata(manifest) {
    if (!manifest) {
        return undefined;
    }
    return manifest[MANIFEST_KEY];
}
export function resolvePackageExtensionEntries(manifest) {
    const raw = getPackageManifestMetadata(manifest)?.extensions;
    if (!Array.isArray(raw)) {
        return { status: "missing", entries: [] };
    }
    const entries = raw.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
    if (entries.length === 0) {
        return { status: "empty", entries: [] };
    }
    return { status: "ok", entries };
}
