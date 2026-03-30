import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  reconcileConfigProviderKeys,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import { clearModelsJsonReadyCache } from "../agents/models-config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { migrateLegacyConfig } from "../config/legacy-migrate.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/types.js";
import { resolveUserPath } from "../utils.js";
import {
  collectCommandSecretAssignmentsFromSnapshot,
  type CommandSecretAssignment,
} from "./command-config.js";
import { resolveSecretRefValues } from "./resolve.js";
import { collectAuthStoreAssignments } from "./runtime-auth-collectors.js";
import { collectConfigAssignments } from "./runtime-config-collectors.js";
import {
  applyResolvedAssignments,
  createResolverContext,
  type SecretResolverWarning,
} from "./runtime-shared.js";
import { resolveRuntimeWebTools, type RuntimeWebToolsMetadata } from "./runtime-web-tools.js";

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
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
}

function collectCandidateAgentDirs(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = new Set<string>();
  dirs.add(resolveUserPath(resolveOpenClawAgentDir(env), env));
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

function resolveLoadablePluginOrigins(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ReadonlyMap<string, PluginOrigin> {
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
  );
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir,
    cache: true,
    env: params.env,
  });
  return new Map(manifestRegistry.plugins.map((record) => [record.id, record.origin]));
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

export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  /** Test override for discovered loadable plugins and their origins. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(
    migrateLegacyConfig(params.config).config ?? params.config,
  );
  const loadablePluginOrigins =
    params.loadablePluginOrigins ??
    resolveLoadablePluginOrigins({ config: sourceConfig, env: runtimeEnv });
  const context = createResolverContext({
    sourceConfig,
    env: runtimeEnv,
  });

  collectConfigAssignments({
    config: resolvedConfig,
    context,
    loadablePluginOrigins,
  });

  const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
  const candidateDirs = params.agentDirs?.length
    ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))]
    : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);

  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  for (const agentDir of candidateDirs) {
    const store = structuredClone(loadAuthStore(agentDir));
    collectAuthStoreAssignments({
      store,
      context,
      agentDir,
    });
    authStores.push({ agentDir, store });
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
    loadAuthStore,
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
      loadablePluginOrigins: resolveLoadablePluginOrigins({
        config: next.sourceConfig,
        env: process.env,
      }),
    } satisfies SecretsRuntimeRefreshContext);
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);

  // Reconcile provider API keys from config into per-agent auth-profiles on
  // disk so that restarted gateways and new sessions pick up the current key.
  const configProviders = next.config.models?.providers;
  if (configProviders) {
    const reconciled = reconcileConfigProviderKeys({
      configProviders,
      authStores: next.authStores,
    });
    if (reconciled) {
      clearModelsJsonReadyCache();
    }
  }

  activeSnapshot = next;
  activeRefreshContext = cloneRefreshContext(refreshContext);
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
  if (!activeSnapshot) {
    return null;
  }
  return structuredClone(activeSnapshot.webTools);
}

export function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
  commandName: string;
  targetIds: ReadonlySet<string>;
}): { assignments: CommandSecretAssignment[]; diagnostics: string[]; inactiveRefPaths: string[] } {
  if (!activeSnapshot) {
    throw new Error("Secrets runtime snapshot is not active.");
  }
  if (params.targetIds.size === 0) {
    return { assignments: [], diagnostics: [], inactiveRefPaths: [] };
  }
  const inactiveRefPaths = [
    ...new Set(
      activeSnapshot.warnings
        .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
        .map((warning) => warning.path),
    ),
  ];
  const resolved = collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig: activeSnapshot.sourceConfig,
    resolvedConfig: activeSnapshot.config,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths: new Set(inactiveRefPaths),
  });
  return {
    assignments: resolved.assignments,
    diagnostics: resolved.diagnostics,
    inactiveRefPaths,
  };
}

export function clearSecretsRuntimeSnapshot(): void {
  clearActiveSecretsRuntimeState();
}
