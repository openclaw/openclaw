import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveUserPath } from "../utils.js";
import { type SecretResolverWarning } from "./runtime-shared.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  getActiveRuntimeWebToolsMetadata as getActiveRuntimeWebToolsMetadataFromState,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.js";

export type { SecretResolverWarning } from "./runtime-shared.js";

export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
  webTools: RuntimeWebToolsMetadata;
};

type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
};

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
] as const;

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;
let activeRefreshContext: SecretsRuntimeRefreshContext | null = null;
const preparedSnapshotRefreshContext = new WeakMap<
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext
>();
let runtimeManifestPromise: Promise<typeof import("./runtime-manifest.runtime.js")> | null = null;
let runtimePreparePromise: Promise<typeof import("./runtime-prepare.runtime.js")> | null = null;

function loadRuntimeManifestHelpers() {
  runtimeManifestPromise ??= import("./runtime-manifest.runtime.js");
  return runtimeManifestPromise;
}

function loadRuntimePrepareHelpers() {
  runtimePreparePromise ??= import("./runtime-prepare.runtime.js");
  return runtimePreparePromise;
}

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
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

function cloneRefreshContext(context: SecretsRuntimeRefreshContext): SecretsRuntimeRefreshContext {
  return {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    loadAuthStore: context.loadAuthStore,
    loadablePluginOrigins: new Map(context.loadablePluginOrigins),
  };
}

function clearActiveSecretsRuntimeState(): void {
  activeSnapshot = null;
  activeRefreshContext = null;
  clearActiveRuntimeWebToolsMetadata();
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
}

function collectCandidateAgentDirs(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = new Set<string>();
  dirs.add(resolveUserPath(resolveDefaultAgentDir(config, env), env));
  for (const agentId of listAgentIds(config)) {
    dirs.add(resolveUserPath(resolveAgentDir(config, agentId, env), env));
  }
  return [...dirs];
}

function resolveRefreshAgentDirs(
  config: OpenClawConfig,
  context: SecretsRuntimeRefreshContext,
): string[] {
  const configDerived = collectCandidateAgentDirs(config, context.env);
  if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) {
    return configDerived;
  }
  return [...new Set([...context.explicitAgentDirs, ...configDerived])];
}

async function resolveLoadablePluginOrigins(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ReadonlyMap<string, PluginOrigin>> {
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
  );
  const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } =
    await loadRuntimeManifestHelpers();
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    workspaceDir,
    env: params.env,
  });
  return listPluginOriginsFromMetadataSnapshot(snapshot);
}

function mergeSecretsRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged = { ...(env ?? process.env) } as Record<string, string | undefined>;
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

function hasConfiguredPluginEntries(config: OpenClawConfig): boolean {
  const entries = config.plugins?.entries;
  return (
    !!entries &&
    typeof entries === "object" &&
    !Array.isArray(entries) &&
    Object.keys(entries).length > 0
  );
}

function hasConfiguredChannelEntries(config: OpenClawConfig): boolean {
  const channels = config.channels;
  return (
    !!channels &&
    typeof channels === "object" &&
    !Array.isArray(channels) &&
    Object.keys(channels).some((channelId) => channelId !== "defaults")
  );
}

function createEmptyRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata {
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

const WEB_FETCH_CREDENTIAL_FIELD_NAMES = new Set(["apikey", "key", "token", "secret", "password"]);

function hasCredentialBearingWebFetchValue(
  value: unknown,
  defaults: Parameters<typeof coerceSecretRef>[1],
  seen = new WeakSet<object>(),
): boolean {
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
    return value.some((entry) => hasCredentialBearingWebFetchValue(entry, defaults, seen));
  }
  return Object.entries(value as Record<string, unknown>).some(([rawKey, entry]) => {
    const key = rawKey.toLowerCase();
    if (WEB_FETCH_CREDENTIAL_FIELD_NAMES.has(key) && entry != null && entry !== "") {
      return true;
    }
    return hasCredentialBearingWebFetchValue(entry, defaults, seen);
  });
}

function hasActiveRuntimeWebFetchProviderSurface(
  fetch: unknown,
  defaults: Parameters<typeof coerceSecretRef>[1],
): boolean {
  if (!fetch || typeof fetch !== "object" || Array.isArray(fetch)) {
    return false;
  }
  const fetchConfig = fetch as Record<string, unknown>;
  if (fetchConfig.enabled === false) {
    return false;
  }
  if (typeof fetchConfig.provider === "string" && fetchConfig.provider.trim()) {
    return true;
  }
  return hasCredentialBearingWebFetchValue(fetchConfig, defaults);
}

function hasRuntimeWebToolConfigSurface(config: OpenClawConfig): boolean {
  const web = config.tools?.web;
  const defaults = config.secrets?.defaults;
  const fetchExplicitlyDisabled =
    web &&
    typeof web === "object" &&
    !Array.isArray(web) &&
    typeof (web as Record<string, unknown>).fetch === "object" &&
    (web as { fetch?: { enabled?: unknown } }).fetch?.enabled === false;
  if (web && typeof web === "object" && !Array.isArray(web)) {
    const webRecord = web as Record<string, unknown>;
    if ("search" in webRecord || "x_search" in webRecord) {
      return true;
    }
    if (
      "fetch" in webRecord &&
      hasActiveRuntimeWebFetchProviderSurface(webRecord.fetch, defaults)
    ) {
      return true;
    }
  }
  const entries = config.plugins?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const pluginConfig = (entry as { config?: unknown }).config;
    return (
      !!pluginConfig &&
      typeof pluginConfig === "object" &&
      !Array.isArray(pluginConfig) &&
      ("webSearch" in pluginConfig || (!fetchExplicitlyDisabled && "webFetch" in pluginConfig))
    );
  });
}

function hasSecretRefCandidate(
  value: unknown,
  defaults: Parameters<typeof coerceSecretRef>[1],
  seen = new WeakSet<object>(),
): boolean {
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
  return Object.values(value as Record<string, unknown>).some((entry) =>
    hasSecretRefCandidate(entry, defaults, seen),
  );
}

function canUseSecretsRuntimeFastPath(params: {
  sourceConfig: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
}): boolean {
  if (hasRuntimeWebToolConfigSurface(params.sourceConfig)) {
    return false;
  }
  const defaults = params.sourceConfig.secrets?.defaults;
  if (hasSecretRefCandidate(params.sourceConfig, defaults)) {
    return false;
  }
  return !params.authStores.some((entry) => hasSecretRefCandidate(entry.store, defaults));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey(value: unknown, key: string): boolean {
  return isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function preserveOmittedRuntimeWebToolSurface(params: {
  nextSourceConfig: OpenClawConfig;
  previousSourceConfig: OpenClawConfig;
}): OpenClawConfig {
  if (!hasRuntimeWebToolConfigSurface(params.previousSourceConfig)) {
    return params.nextSourceConfig;
  }

  let merged: OpenClawConfig | null = null;
  const ensureMerged = (): OpenClawConfig => {
    merged ??= structuredClone(params.nextSourceConfig);
    return merged;
  };

  const previousWeb = params.previousSourceConfig.tools?.web;
  if (isPlainRecord(previousWeb)) {
    for (const key of ["search", "x_search", "fetch"] as const) {
      if (!hasOwnKey(previousWeb, key) || hasOwnKey(params.nextSourceConfig.tools?.web, key)) {
        continue;
      }
      const next = ensureMerged();
      next.tools = isPlainRecord(next.tools) ? next.tools : {};
      next.tools.web = isPlainRecord(next.tools.web) ? next.tools.web : {};
      (next.tools.web as Record<string, unknown>)[key] = structuredClone(previousWeb[key]);
    }
  }

  const previousEntries = params.previousSourceConfig.plugins?.entries;
  if (isPlainRecord(previousEntries)) {
    for (const [pluginId, previousEntry] of Object.entries(previousEntries)) {
      if (!isPlainRecord(previousEntry) || !isPlainRecord(previousEntry.config)) {
        continue;
      }
      for (const key of ["webSearch", "webFetch"] as const) {
        if (!hasOwnKey(previousEntry.config, key)) {
          continue;
        }
        const nextEntry = params.nextSourceConfig.plugins?.entries?.[pluginId];
        const nextConfig = isPlainRecord(nextEntry) ? nextEntry.config : undefined;
        if (hasOwnKey(nextConfig, key)) {
          continue;
        }
        const next = ensureMerged();
        next.plugins = isPlainRecord(next.plugins) ? next.plugins : {};
        next.plugins.entries = isPlainRecord(next.plugins.entries) ? next.plugins.entries : {};
        const mergedEntry = isPlainRecord(next.plugins.entries[pluginId])
          ? next.plugins.entries[pluginId]
          : structuredClone(previousEntry);
        next.plugins.entries[pluginId] = mergedEntry;
        mergedEntry.config = isPlainRecord(mergedEntry.config) ? mergedEntry.config : {};
        mergedEntry.config[key] = structuredClone(previousEntry.config[key]);
      }
    }
  }

  return merged ?? params.nextSourceConfig;
}

export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  /** Test override for discovered loadable plugins and their origins. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
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
      loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
    });
    return snapshot;
  }

  const {
    applyResolvedAssignments,
    collectAuthStoreAssignments,
    collectConfigAssignments,
    createResolverContext,
    resolveRuntimeWebTools,
    resolveSecretRefValues,
  } = await loadRuntimePrepareHelpers();
  const loadablePluginOrigins =
    params.loadablePluginOrigins ??
    (hasConfiguredPluginEntries(sourceConfig) || hasConfiguredChannelEntries(sourceConfig)
      ? await resolveLoadablePluginOrigins({ config: sourceConfig, env: runtimeEnv })
      : new Map<string, PluginOrigin>());
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

export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const next = cloneSnapshot(snapshot);
  const refreshContext =
    preparedSnapshotRefreshContext.get(snapshot) ??
    activeRefreshContext ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
      loadablePluginOrigins: new Map<string, PluginOrigin>(),
    } satisfies SecretsRuntimeRefreshContext);
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
      const refreshSourceConfig = preserveOmittedRuntimeWebToolSurface({
        nextSourceConfig: sourceConfig,
        previousSourceConfig: activeSnapshot.sourceConfig,
      });
      const refreshed = await prepareSecretsRuntimeSnapshot({
        config: refreshSourceConfig,
        env: activeRefreshContext.env,
        agentDirs: resolveRefreshAgentDirs(refreshSourceConfig, activeRefreshContext),
        loadAuthStore: activeRefreshContext.loadAuthStore,
        loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
      });
      activateSecretsRuntimeSnapshot(refreshed);
      return true;
    },
  });
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  if (!activeSnapshot) {
    return null;
  }
  const snapshot = cloneSnapshot(activeSnapshot);
  if (activeRefreshContext) {
    preparedSnapshotRefreshContext.set(snapshot, cloneRefreshContext(activeRefreshContext));
  }
  return snapshot;
}

export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  return getActiveRuntimeWebToolsMetadataFromState();
}

export function clearSecretsRuntimeSnapshot(): void {
  clearActiveSecretsRuntimeState();
}
