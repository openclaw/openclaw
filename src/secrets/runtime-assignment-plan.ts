/** Builds the canonical non-resolving assignment plan for secrets runtime preparation. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { loadAuthProfileStoreForSecretsRuntime } from "../agents/auth-profiles.js";
import {
  AuthProfileMigrationRequiredError,
  markAuthProfileMigrationRequired,
} from "../agents/auth-profiles/legacy-source-diagnostic.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { secretRefKey } from "./ref-contract.js";
import type { DegradedSecretOwner } from "./runtime-degraded-state.js";
import { collectCandidateAgentDirs, mergeSecretsRuntimeEnv } from "./runtime-fast-path.js";
import {
  hasConfiguredPluginIntegrationSecretProviders,
  resolveSecretsPluginMetadata,
  shouldLoadPluginMetadataForSecrets,
} from "./runtime-plugin-metadata.js";

const loadRuntimePrepareHelpers = createLazyRuntimeModule(
  () => import("./runtime-prepare.runtime.js"),
);

export function loadAuthStoresWithMigrationIsolation(params: {
  agentDirs: readonly string[];
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
  allowUnavailable: boolean;
}): {
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  degradedOwners: DegradedSecretOwner[];
} {
  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  const degradedOwners: DegradedSecretOwner[] = [];
  for (const agentDir of params.agentDirs) {
    try {
      authStores.push({ agentDir, store: structuredClone(params.loadAuthStore(agentDir)) });
    } catch (error) {
      if (!(error instanceof AuthProfileMigrationRequiredError) || !params.allowUnavailable) {
        throw error;
      }
      markAuthProfileMigrationRequired(agentDir, error);
      authStores.push({ agentDir, store: { version: 1, profiles: {} } });
      degradedOwners.push({
        ownerKind: "route",
        ownerId: error.ownerId,
        state: "unavailable",
        degradationState: "cold",
        paths: error.sourceKinds.map((kind) => `auth-profile-legacy:${kind}`),
        refKeys: [],
        reason: "auth profile migration required",
      });
    }
  }
  return { authStores, degradedOwners };
}

export async function buildSecretsRuntimeAssignmentPlan(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  runtimeEnv: NodeJS.ProcessEnv;
  candidateDirs: readonly string[];
  includeConfigRefs: boolean;
  includeAuthStoreRefs: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  preloadedAuthStores?: Array<{ agentDir: string; store: AuthProfileStore }>;
  preloadedMigrationDegradedOwners?: DegradedSecretOwner[];
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry">;
  allowUnavailableSecretOwners?: boolean;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}) {
  const { collectAuthStoreAssignments, collectConfigAssignments, createResolverContext } =
    await loadRuntimePrepareHelpers();
  let manifestRegistry = params.manifestRegistry ?? params.pluginMetadataSnapshot?.manifestRegistry;
  let loadablePluginOrigins = params.loadablePluginOrigins;
  if (
    shouldLoadPluginMetadataForSecrets(params.sourceConfig) &&
    (!loadablePluginOrigins ||
      (!manifestRegistry && hasConfiguredPluginIntegrationSecretProviders(params.sourceConfig)))
  ) {
    const pluginMetadata = await resolveSecretsPluginMetadata({
      config: params.sourceConfig,
      env: params.runtimeEnv,
      pluginMetadataSnapshot:
        params.pluginMetadataSnapshot ??
        (manifestRegistry ? { plugins: manifestRegistry.plugins, manifestRegistry } : undefined),
    });
    loadablePluginOrigins ??= pluginMetadata.loadablePluginOrigins;
    manifestRegistry ??= pluginMetadata.manifestRegistry;
  }
  loadablePluginOrigins ??= new Map<string, PluginOrigin>();
  const context = createResolverContext({
    sourceConfig: params.sourceConfig,
    env: params.runtimeEnv,
    ...(manifestRegistry ? { manifestRegistry } : {}),
  });

  if (params.includeConfigRefs) {
    collectConfigAssignments({
      config: params.resolvedConfig,
      context,
      loadablePluginOrigins,
    });
  }

  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  let migrationDegradedOwners: DegradedSecretOwner[] = [];
  if (params.includeAuthStoreRefs) {
    if (params.preloadedAuthStores) {
      authStores = params.preloadedAuthStores;
      migrationDegradedOwners = params.preloadedMigrationDegradedOwners ?? [];
    } else {
      const loaded = loadAuthStoresWithMigrationIsolation({
        agentDirs: params.candidateDirs,
        loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
        allowUnavailable: params.allowUnavailableSecretOwners === true,
      });
      authStores = loaded.authStores;
      migrationDegradedOwners = loaded.degradedOwners;
    }
    for (const entry of authStores) {
      collectAuthStoreAssignments({
        store: entry.store,
        context,
        agentDir: entry.agentDir,
      });
    }
  }

  return {
    authStores,
    context,
    loadablePluginOrigins,
    manifestRegistry,
    migrationDegradedOwners,
  };
}

/** Builds the exact non-resolving SecretRef plan a cold start would select. */
export async function buildActiveSecretsRuntimePreflightPlan(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
}): Promise<{
  refs: SecretRef[];
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}> {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const candidateDirs = params.agentDirs?.length
    ? uniqueStrings(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))
    : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
  const plan = await buildSecretsRuntimeAssignmentPlan({
    sourceConfig,
    resolvedConfig,
    runtimeEnv,
    candidateDirs,
    includeConfigRefs: true,
    includeAuthStoreRefs: true,
    ...(params.loadAuthStore ? { loadAuthStore: params.loadAuthStore } : {}),
  });
  const refsByKey = new Map<string, SecretRef>();
  for (const assignment of plan.context.assignments) {
    refsByKey.set(secretRefKey(assignment.ref), assignment.ref);
  }
  const { resolveRuntimeWebTools } = await loadRuntimePrepareHelpers();
  await resolveRuntimeWebTools({
    sourceConfig,
    resolvedConfig,
    context: plan.context,
    inspectSecretRef: (ref) => {
      refsByKey.set(secretRefKey(ref), ref);
      return "openclaw-secret-preflight";
    },
  });
  return {
    refs: [...refsByKey.values()],
    ...(plan.manifestRegistry ? { manifestRegistry: plan.manifestRegistry } : {}),
  };
}
