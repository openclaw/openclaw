import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId, } from "../agents/agent-scope.js";
import { clearRuntimeAuthProfileStoreSnapshots, loadAuthProfileStoreForSecretsRuntime, loadAuthProfileStoreWithoutExternalProfiles, replaceRuntimeAuthProfileStoreSnapshots, } from "../agents/auth-profiles.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshotRefreshHandler, setRuntimeConfigSnapshot, } from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { resolveUserPath } from "../utils.js";
import { clearActiveRuntimeWebToolsMetadata, getActiveRuntimeWebToolsMetadata as getActiveRuntimeWebToolsMetadataFromState, setActiveRuntimeWebToolsMetadata, } from "./runtime-web-tools-state.js";
const RUNTIME_PATH_ENV_KEYS = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OPENCLAW_TEST_FAST",
];
let activeSnapshot = null;
let activeRefreshContext = null;
const preparedSnapshotRefreshContext = new WeakMap();
let runtimeManifestPromise = null;
let runtimePreparePromise = null;
function loadRuntimeManifestHelpers() {
    runtimeManifestPromise ??= import("./runtime-manifest.runtime.js");
    return runtimeManifestPromise;
}
function loadRuntimePrepareHelpers() {
    runtimePreparePromise ??= import("./runtime-prepare.runtime.js");
    return runtimePreparePromise;
}
function cloneSnapshot(snapshot) {
    return {
        sourceConfig: structuredClone(snapshot.sourceConfig),
        config: structuredClone(snapshot.config),
        authStores: snapshot.authStores.map((entry) => ({
            agentDir: entry.agentDir,
            store: structuredClone(entry.store),
        })),
        warnings: snapshot.warnings.map((warning) => ({ ...warning })),
        webTools: structuredClone(snapshot.webTools),
    };
}
function cloneRefreshContext(context) {
    return {
        env: { ...context.env },
        explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
        loadAuthStore: context.loadAuthStore,
        loadablePluginOrigins: new Map(context.loadablePluginOrigins),
    };
}
function clearActiveSecretsRuntimeState() {
    activeSnapshot = null;
    activeRefreshContext = null;
    clearActiveRuntimeWebToolsMetadata();
    setRuntimeConfigSnapshotRefreshHandler(null);
    clearRuntimeConfigSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
}
function collectCandidateAgentDirs(config, env = process.env) {
    const dirs = new Set();
    dirs.add(resolveUserPath(resolveOpenClawAgentDir(env), env));
    for (const agentId of listAgentIds(config)) {
        dirs.add(resolveUserPath(resolveAgentDir(config, agentId, env), env));
    }
    return [...dirs];
}
function resolveRefreshAgentDirs(config, context) {
    const configDerived = collectCandidateAgentDirs(config, context.env);
    if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) {
        return configDerived;
    }
    return [...new Set([...context.explicitAgentDirs, ...configDerived])];
}
async function resolveLoadablePluginOrigins(params) {
    const workspaceDir = resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
    const { loadPluginManifestRegistry } = await loadRuntimeManifestHelpers();
    const manifestRegistry = loadPluginManifestRegistry({
        config: params.config,
        workspaceDir,
        cache: true,
        env: params.env,
    });
    return new Map(manifestRegistry.plugins.map((record) => [record.id, record.origin]));
}
function mergeSecretsRuntimeEnv(env) {
    const merged = { ...(env ?? process.env) };
    for (const key of RUNTIME_PATH_ENV_KEYS) {
        if (merged[key] !== undefined) {
            continue;
        }
        const processValue = process.env[key];
        if (processValue !== undefined) {
            merged[key] = processValue;
        }
    }
    return merged;
}
function hasConfiguredPluginEntries(config) {
    const entries = config.plugins?.entries;
    return (!!entries &&
        typeof entries === "object" &&
        !Array.isArray(entries) &&
        Object.keys(entries).length > 0);
}
function createEmptyRuntimeWebToolsMetadata() {
    return {
        search: {
            providerSource: "none",
            diagnostics: [],
        },
        fetch: {
            providerSource: "none",
            diagnostics: [],
        },
        diagnostics: [],
    };
}
function hasRuntimeWebToolConfigSurface(config) {
    const web = config.tools?.web;
    if (web && typeof web === "object" && ("search" in web || "fetch" in web || "x_search" in web)) {
        return true;
    }
    const entries = config.plugins?.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return false;
    }
    return Object.values(entries).some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return false;
        }
        const pluginConfig = entry.config;
        return (!!pluginConfig &&
            typeof pluginConfig === "object" &&
            !Array.isArray(pluginConfig) &&
            ("webSearch" in pluginConfig || "webFetch" in pluginConfig));
    });
}
function hasSecretRefCandidate(value, defaults, seen = new WeakSet()) {
    if (coerceSecretRef(value, defaults)) {
        return true;
    }
    if (!value || typeof value !== "object") {
        return false;
    }
    if (seen.has(value)) {
        return false;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.some((entry) => hasSecretRefCandidate(entry, defaults, seen));
    }
    return Object.values(value).some((entry) => hasSecretRefCandidate(entry, defaults, seen));
}
function canUseSecretsRuntimeFastPath(params) {
    if (hasRuntimeWebToolConfigSurface(params.sourceConfig)) {
        return false;
    }
    const defaults = params.sourceConfig.secrets?.defaults;
    if (hasSecretRefCandidate(params.sourceConfig, defaults)) {
        return false;
    }
    return !params.authStores.some((entry) => hasSecretRefCandidate(entry.store, defaults));
}
export async function prepareSecretsRuntimeSnapshot(params) {
    const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
    const sourceConfig = structuredClone(params.config);
    const resolvedConfig = structuredClone(params.config);
    const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
    let authStores = [];
    const fastPathLoadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreWithoutExternalProfiles;
    const candidateDirs = params.agentDirs?.length
        ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))]
        : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
    if (includeAuthStoreRefs) {
        for (const agentDir of candidateDirs) {
            authStores.push({
                agentDir,
                store: structuredClone(fastPathLoadAuthStore(agentDir)),
            });
        }
    }
    if (canUseSecretsRuntimeFastPath({ sourceConfig, authStores })) {
        const snapshot = {
            sourceConfig,
            config: resolvedConfig,
            authStores,
            warnings: [],
            webTools: createEmptyRuntimeWebToolsMetadata(),
        };
        preparedSnapshotRefreshContext.set(snapshot, {
            env: runtimeEnv,
            explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
            loadAuthStore: fastPathLoadAuthStore,
            loadablePluginOrigins: params.loadablePluginOrigins ?? new Map(),
        });
        return snapshot;
    }
    const { applyResolvedAssignments, collectAuthStoreAssignments, collectConfigAssignments, createResolverContext, resolveRuntimeWebTools, resolveSecretRefValues, } = await loadRuntimePrepareHelpers();
    const loadablePluginOrigins = params.loadablePluginOrigins ??
        (hasConfiguredPluginEntries(sourceConfig)
            ? await resolveLoadablePluginOrigins({ config: sourceConfig, env: runtimeEnv })
            : new Map());
    const context = createResolverContext({
        sourceConfig,
        env: runtimeEnv,
    });
    collectConfigAssignments({
        config: resolvedConfig,
        context,
        loadablePluginOrigins,
    });
    if (includeAuthStoreRefs) {
        const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
        if (!params.loadAuthStore) {
            authStores = candidateDirs.map((agentDir) => ({
                agentDir,
                store: structuredClone(loadAuthStore(agentDir)),
            }));
        }
        for (const entry of authStores) {
            collectAuthStoreAssignments({
                store: entry.store,
                context,
                agentDir: entry.agentDir,
            });
        }
    }
    if (context.assignments.length > 0) {
        const refs = context.assignments.map((assignment) => assignment.ref);
        const resolved = await resolveSecretRefValues(refs, {
            config: sourceConfig,
            env: context.env,
            cache: context.cache,
        });
        applyResolvedAssignments({
            assignments: context.assignments,
            resolved,
        });
    }
    const snapshot = {
        sourceConfig,
        config: resolvedConfig,
        authStores,
        warnings: context.warnings,
        webTools: await resolveRuntimeWebTools({
            sourceConfig,
            resolvedConfig,
            context,
        }),
    };
    preparedSnapshotRefreshContext.set(snapshot, {
        env: runtimeEnv,
        explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
        loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
        loadablePluginOrigins,
    });
    return snapshot;
}
export function activateSecretsRuntimeSnapshot(snapshot) {
    const next = cloneSnapshot(snapshot);
    const refreshContext = preparedSnapshotRefreshContext.get(snapshot) ??
        activeRefreshContext ??
        {
            env: { ...process.env },
            explicitAgentDirs: null,
            loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
            loadablePluginOrigins: new Map(),
        };
    setRuntimeConfigSnapshot(next.config, next.sourceConfig);
    replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
    activeSnapshot = next;
    activeRefreshContext = cloneRefreshContext(refreshContext);
    setActiveRuntimeWebToolsMetadata(next.webTools);
    setRuntimeConfigSnapshotRefreshHandler({
        refresh: async ({ sourceConfig }) => {
            if (!activeSnapshot || !activeRefreshContext) {
                return false;
            }
            const refreshed = await prepareSecretsRuntimeSnapshot({
                config: sourceConfig,
                env: activeRefreshContext.env,
                agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
                loadAuthStore: activeRefreshContext.loadAuthStore,
                loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
            });
            activateSecretsRuntimeSnapshot(refreshed);
            return true;
        },
    });
}
export function getActiveSecretsRuntimeSnapshot() {
    if (!activeSnapshot) {
        return null;
    }
    const snapshot = cloneSnapshot(activeSnapshot);
    if (activeRefreshContext) {
        preparedSnapshotRefreshContext.set(snapshot, cloneRefreshContext(activeRefreshContext));
    }
    return snapshot;
}
export function getActiveRuntimeWebToolsMetadata() {
    return getActiveRuntimeWebToolsMetadataFromState();
}
export function clearSecretsRuntimeSnapshot() {
    clearActiveSecretsRuntimeState();
}
