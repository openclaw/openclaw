import type { OwnedRuntimeAuthProfileStoreSnapshotEntry } from "../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { DegradedSecretOwner, SecretOwnerRefState } from "./runtime-degraded-state.js";
import type {
  SecretResolverWarning,
  SecretExecutionEnvironmentExclusions,
} from "./runtime-shared.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

/** Prepared secrets runtime snapshot activated for fast secret resolution. */
export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: OwnedRuntimeAuthProfileStoreSnapshotEntry[];
  authStoreCredentialsRevision: number;
  authStoreSnapshotsRevision: number;
  warnings: SecretResolverWarning[];
  degradedOwners?: DegradedSecretOwner[];
  secretOwners?: SecretOwnerRefState[];
  webTools: RuntimeWebToolsMetadata;
  executionEnvironmentExclusions?: SecretExecutionEnvironmentExclusions;
};

/** Return mutable copies; the publication owner freezes its source revision separately. */
export function cloneSecretsRuntimeSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
  authStores: PreparedSecretsRuntimeSnapshot["authStores"],
): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: cloneConfigWithResolutionFacts(snapshot.sourceConfig),
    config: cloneConfigWithResolutionFacts(snapshot.config),
    authStores,
    authStoreCredentialsRevision: snapshot.authStoreCredentialsRevision,
    authStoreSnapshotsRevision: snapshot.authStoreSnapshotsRevision,
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    degradedOwners: structuredClone(snapshot.degradedOwners ?? []),
    secretOwners: structuredClone(snapshot.secretOwners ?? []),
    webTools: structuredClone(snapshot.webTools),
    ...(snapshot.executionEnvironmentExclusions
      ? {
          executionEnvironmentExclusions: Object.freeze({
            credentialScrubEnv: Object.freeze({
              ...snapshot.executionEnvironmentExclusions.credentialScrubEnv,
            }),
            excludedStoreNames: Object.freeze([
              ...snapshot.executionEnvironmentExclusions.excludedStoreNames,
            ]),
          }),
        }
      : {}),
  };
}

/** Context needed to refresh active secrets runtime snapshots without losing plugin origin data. */
export type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  includeConfigRefs?: boolean;
  includeAuthStoreRefs: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore | Promise<AuthProfileStore>;
  loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
};

/**
 * Clones refresh context while preserving callback identity and isolating mutable maps/config.
 */
export function cloneSecretsRuntimeRefreshContext(
  context: SecretsRuntimeRefreshContext,
): SecretsRuntimeRefreshContext {
  return {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    includeConfigRefs: context.includeConfigRefs ?? true,
    includeAuthStoreRefs: context.includeAuthStoreRefs,
    loadablePluginOrigins: new Map(context.loadablePluginOrigins),
    ...(context.manifestRegistry ? { manifestRegistry: context.manifestRegistry } : {}),
    ...(context.loadAuthStore ? { loadAuthStore: context.loadAuthStore } : {}),
  };
}
