import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntimeAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  resolveCliAuthBindingFingerprint,
  resolveCliRuntimeArtifactFingerprint,
  resolveCliRuntimeOwnerFingerprint,
} from "../agents/cli-auth-epoch.js";
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintAuthProfileCredential,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
  type AgentExecutionAuthBinding,
  type OpaqueRuntimeOwnerKind,
} from "../agents/execution-auth-binding.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type {
  AgentHarnessRuntimeArtifactBinding,
  ExpectedAgentHarnessRuntimeArtifact,
} from "../agents/harness/runtime-artifact.types.js";
import { resolveAgentHarnessOwnerPluginIds } from "../agents/harness/runtime-plugin.js";
import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import { loadPluginRegistrySnapshot } from "../plugins/plugin-registry.js";
import {
  fingerprintPluginRuntimeArtifact,
  loadPluginRuntimeArtifactIdentitySources,
  type PluginRuntimeArtifactIdentitySource,
} from "../plugins/plugin-runtime-artifact-identity.js";
import {
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProviderRef,
} from "../plugins/providers.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type SystemAgentConfiguredRouteIdentity = DistributiveOmit<
  SystemAgentConfiguredRoute,
  "runConfig" | "sourceConfig" | "authProfileId"
>;
type SystemAgentVerifiedExecutionRoute =
  | Extract<SystemAgentConfiguredRoute, { runner: "cli" }>
  | (Extract<SystemAgentConfiguredRoute, { runner: "embedded" }> & {
      agentHarnessRuntimeOverride: string;
    });

type SystemAgentVerifiedInferenceState = Readonly<{
  config: OpenClawConfig;
  route: SystemAgentVerifiedExecutionRoute;
}>;

type SystemAgentVerifiedExecutionFingerprint = Awaited<
  ReturnType<typeof projectVerifiedExecutionFingerprint>
>;
type SystemAgentOwnerPluginRuntimeIdentity = Readonly<ReturnType<typeof projectOwnerPluginRuntime>>;

type SystemAgentOwnerPluginArtifactIdentity = Readonly<{
  pluginId: string;
  fingerprint: string;
}>;

export type SystemAgentOwnerPluginArtifactSnapshot = Readonly<{
  ownerPluginIds: readonly string[];
  ownerPluginArtifacts: readonly SystemAgentOwnerPluginArtifactIdentity[];
}>;

type SystemAgentOwnerPluginRegistryRecord = PluginRuntimeArtifactIdentitySource & {
  manifestPath: string;
  manifestHash: string;
  packageName?: string;
  packageVersion?: string;
  installRecordHash?: string;
  packageJson?: { path: string; hash: string };
};

/** Server-local proof returned only after the exact route completes a live turn. */
export type SystemAgentVerifiedInferenceBinding = Readonly<{
  configuredRoute: SystemAgentConfiguredRouteIdentity;
  execution: SystemAgentVerifiedExecutionRoute;
  executionFingerprint: SystemAgentVerifiedExecutionFingerprint;
  ownerPluginIds: readonly string[];
  ownerPluginArtifacts: readonly SystemAgentOwnerPluginArtifactIdentity[];
  auth: Readonly<{
    authProfileId?: string;
    agentHarnessId?: string;
    modelId?: string;
    modelApi?: string;
    authFingerprint: string;
    proofKind?: "runtime-owner";
    runtimeOwnerKind?: OpaqueRuntimeOwnerKind;
    runtimeOwnerId?: string;
    runtimeArtifactFingerprint?: string;
    runtimeArtifactId?: string;
    skipLocalCredential?: true;
  }>;
}>;

/** Exact child harness artifact every verified embedded OpenClaw call must carry. */
export function resolveSystemAgentExpectedAgentHarnessRuntimeArtifact(
  binding: SystemAgentVerifiedInferenceBinding,
): ExpectedAgentHarnessRuntimeArtifact | undefined {
  if (
    binding.execution.runner !== "embedded" ||
    binding.execution.agentHarnessRuntimeOverride === "openclaw"
  ) {
    return undefined;
  }
  const harnessId = binding.execution.agentHarnessRuntimeOverride;
  const artifactId = binding.auth.runtimeArtifactId?.trim();
  const fingerprint = binding.auth.runtimeArtifactFingerprint;
  if (binding.auth.agentHarnessId !== harnessId || !artifactId || !fingerprint) {
    throw new Error("The verified inference harness artifact is incomplete.");
  }
  return {
    harnessId,
    artifact: { id: artifactId, fingerprint },
  };
}

async function validateAgentHarnessRuntimeArtifact(params: {
  harnessId: string;
  artifact: AgentHarnessRuntimeArtifactBinding;
}): Promise<boolean> {
  try {
    const harness = getRegisteredAgentHarness(params.harnessId)?.harness;
    return (await harness?.runtimeArtifact?.validate(params.artifact)) === true;
  } catch {
    return false;
  }
}

function systemAgentRouteIdentity(
  route: SystemAgentConfiguredRoute,
): SystemAgentConfiguredRouteIdentity {
  const {
    runConfig: _runConfig,
    sourceConfig: _sourceConfig,
    authProfileId: _authProfileId,
    ...identity
  } = route;
  return identity;
}

function loadRouteAuthProfileStore(
  route: SystemAgentVerifiedExecutionRoute,
): Promise<AuthProfileStore> {
  return loadAuthProfileStoreForRuntimeAsync(route.agentDir, {
    readOnly: true,
    migrationProvider: route.provider,
    allowKeychainPrompt: false,
    config: route.runConfig,
    externalCliProviderIds: [route.provider],
  });
}

function projectRelevantPlugins(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRouteIdentity | null,
  ownerPluginIds: readonly string[],
): unknown {
  if (!route || ownerPluginIds.length === 0) {
    return undefined;
  }
  const normalizedPlugins = normalizePluginsConfig(config.plugins);
  return Object.fromEntries(
    ownerPluginIds.map((id) => [
      id,
      {
        active: passesManifestOwnerBasePolicy({
          plugin: { id },
          normalizedConfig: normalizedPlugins,
        }),
        entry: normalizedPlugins.entries[id],
      },
    ]),
  );
}

function projectOwnerPluginRuntime(record: SystemAgentOwnerPluginRegistryRecord) {
  return {
    pluginId: record.pluginId,
    origin: record.origin,
    rootDir: record.rootDir,
    manifestPath: record.manifestPath,
    manifestHash: record.manifestHash,
    source: record.source ?? null,
    packageName: record.packageName ?? null,
    packageVersion: record.packageVersion ?? null,
    installRecordHash: record.installRecordHash ?? null,
    packageJson: record.packageJson
      ? ({ path: record.packageJson.path, hash: record.packageJson.hash } as const)
      : null,
  };
}

// Plugin ids alone survive an in-place runtime replacement. Bind the selected
// installed source and package identity so a stale inference proof cannot write.
function projectOwnerPluginRuntimes(params: {
  config: OpenClawConfig;
  route: SystemAgentConfiguredRoute;
  ownerPluginIds: readonly string[];
}): readonly SystemAgentOwnerPluginRuntimeIdentity[] {
  if (params.ownerPluginIds.length === 0) {
    return [];
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.route.agentId, process.env);
  const registry = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir,
    env: process.env,
  });
  const recordsById = new Map(registry.plugins.map((record) => [record.pluginId, record]));
  return params.ownerPluginIds.map((pluginId) => {
    const record = recordsById.get(pluginId);
    if (!record) {
      throw new Error(`The inference owner plugin ${pluginId} is not installed.`);
    }
    return projectOwnerPluginRuntime(record);
  });
}

function projectOwnerPluginArtifacts(params: {
  config: OpenClawConfig;
  route: SystemAgentConfiguredRoute;
  ownerPluginIds: readonly string[];
}): SystemAgentOwnerPluginArtifactIdentity[] {
  if (params.ownerPluginIds.length === 0) {
    return [];
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.route.agentId, process.env);
  const registryParams = { config: params.config, workspaceDir, env: process.env };
  const records = loadPluginRuntimeArtifactIdentitySources(registryParams);
  const recordsById = new Map(records.map((record) => [record.pluginId, record]));
  return params.ownerPluginIds.map((pluginId) => {
    const record = recordsById.get(pluginId);
    if (!record) {
      throw new Error(`The inference owner plugin ${pluginId} is not installed.`);
    }
    return {
      pluginId,
      fingerprint: fingerprintPluginRuntimeArtifact({
        pluginId,
        origin: record.origin,
        rootDir: record.rootDir,
        ...(record.source ? { source: record.source } : {}),
        ...(record.packageBuild ? { packageBuild: record.packageBuild } : {}),
        sourcePreferred: record.sourcePreferred,
      }),
    };
  });
}
async function projectVerifiedExecutionFingerprint(
  config: OpenClawConfig,
  route: SystemAgentVerifiedExecutionRoute,
  ownerPluginIds: readonly string[],
) {
  const projection = await projectInferenceRoute(config, route.agentId, {
    modelTarget: route.modelTarget,
  });
  const { authProfileId: _authProfileId, ...routeIdentity } = projection.route ?? {};
  return {
    route: projection.route ? routeIdentity : null,
    defaultSelection: projection.defaultSelection,
    auth: projection.auth,
    models: projection.models,
    defaults: projection.defaults,
    ...(projection.agent === undefined ? {} : { agent: projection.agent }),
    plugins: projectRelevantPlugins(config, projection.route, ownerPluginIds),
    ownerPluginRuntimes: projectOwnerPluginRuntimes({
      config,
      route,
      ownerPluginIds,
    }),
  };
}

function resolveRouteHarnessOwnerPluginIds(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRoute,
): string[] {
  if (
    route.runner !== "embedded" ||
    !route.agentHarnessRuntimeOverride ||
    route.agentHarnessRuntimeOverride === "openclaw"
  ) {
    return [];
  }
  const workspaceDir = resolveAgentWorkspaceDir(config, route.agentId, process.env);
  return resolveAgentHarnessOwnerPluginIds({
    runtime: route.agentHarnessRuntimeOverride,
    provider: route.provider,
    config,
    workspaceDir,
  });
}

function resolveRouteOwnerPluginIds(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRoute,
): string[] {
  const workspaceDir = resolveAgentWorkspaceDir(config, route.agentId, process.env);
  return [
    ...resolveOwningPluginIdsForModelRefs({
      models: [route.modelLabel],
      config,
      workspaceDir,
      env: process.env,
    }),
    ...(resolveOwningPluginIdsForProviderRef({
      provider: route.provider,
      config,
      workspaceDir,
      env: process.env,
    }) ?? []),
    ...resolveRouteHarnessOwnerPluginIds(config, route),
  ]
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .toSorted();
}

/** Capture once immediately before a live setup turn. */
export function captureSystemAgentOwnerPluginArtifacts(params: {
  config: OpenClawConfig;
  executionRoute: SystemAgentConfiguredRoute;
}): SystemAgentOwnerPluginArtifactSnapshot {
  const ownerPluginIds = resolveRouteOwnerPluginIds(params.config, params.executionRoute);
  return {
    ownerPluginIds,
    ownerPluginArtifacts: projectOwnerPluginArtifacts({
      config: params.config,
      route: params.executionRoute,
      ownerPluginIds,
    }),
  };
}

async function resolveExecutionAuthFingerprint(
  route: SystemAgentVerifiedExecutionRoute,
  authBinding: AgentExecutionAuthBinding,
  proofKind: "runtime-owner" | "credential" | undefined,
  runtimeArtifactFingerprint: string | undefined,
): Promise<string | undefined> {
  const { authProfileId, skipLocalCredential } = authBinding;
  if (proofKind === "runtime-owner") {
    const kind = authBinding.runtimeOwnerKind!;
    const runtimeOwnerId = authBinding.runtimeOwnerId!;
    if (route.runner === "cli") {
      if (kind !== "cli-runtime") {
        return undefined;
      }
      return resolveCliRuntimeOwnerFingerprint({
        provider: route.provider,
        config: route.runConfig,
        agentDir: route.agentDir,
        agentId: route.agentId,
        runtimeOwnerId,
        ...(authProfileId ? { authProfileId } : {}),
        ...(skipLocalCredential ? { skipLocalCredential: true } : {}),
        ...(runtimeArtifactFingerprint ? { runtimeArtifactFingerprint } : {}),
      });
    }
    let authProfileOwnerFingerprint: string | undefined;
    if (authProfileId) {
      const store = await loadRouteAuthProfileStore(route);
      authProfileOwnerFingerprint = fingerprintAuthProfileOwnerShape({
        profileId: authProfileId,
        credential: store.profiles[authProfileId],
      });
      if (!authProfileOwnerFingerprint) {
        return undefined;
      }
    }
    if (kind === "plugin-harness") {
      if (route.agentHarnessRuntimeOverride === "openclaw") {
        return undefined;
      }
      return fingerprintOpaqueRuntimeOwner({
        kind: "plugin-harness",
        runner: "embedded",
        provider: route.provider,
        backendId: route.agentHarnessRuntimeOverride,
        ...(runtimeArtifactFingerprint ? { runtimeArtifactFingerprint } : {}),
        ...(authProfileId ? { authProfileId } : {}),
        ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
      });
    }
    if (kind !== "aws-sdk") {
      return undefined;
    }
    const auth = await resolveApiKeyForProviderCore({
      provider: route.provider,
      cfg: route.runConfig,
      agentDir: route.agentDir,
      workspaceDir: resolveAgentWorkspaceDir(route.runConfig, route.agentId, process.env),
      ...(authProfileId ? { profileId: authProfileId, lockedProfile: true as const } : {}),
      secretSentinels: true,
    });
    if (authProfileId && auth.profileId !== authProfileId) {
      return undefined;
    }
    return fingerprintAwsSdkRuntimeOwner({
      provider: route.provider,
      backendId: route.agentHarnessRuntimeOverride,
      auth,
    });
  }
  const { modelId, modelApi } = authBinding;
  if (route.runner === "cli") {
    let resolvedAuth: ResolvedProviderAuth | undefined;
    if (authProfileId) {
      const store = await loadRouteAuthProfileStore(route);
      const authCredential = store.profiles[authProfileId];
      const needsMaterializedSecret =
        (authCredential?.type === "api_key" && !authCredential.key) ||
        (authCredential?.type === "token" && !authCredential.token);
      if (needsMaterializedSecret) {
        resolvedAuth = await resolveApiKeyForProviderCore({
          store,
          provider: route.provider,
          cfg: route.runConfig,
          agentDir: route.agentDir,
          workspaceDir: resolveAgentWorkspaceDir(route.runConfig, route.agentId, process.env),
          profileId: authProfileId,
          lockedProfile: true,
          // The CLI bridge hashed the raw resolved value it forwarded. A
          // sentinel would describe the reference, not the executed secret.
          secretSentinels: false,
        });
        if (resolvedAuth.profileId !== authProfileId || !resolvedAuth.apiKey || !authCredential) {
          return undefined;
        }
      }
    }
    return resolveCliAuthBindingFingerprint({
      provider: route.provider,
      config: route.runConfig,
      agentDir: route.agentDir,
      ...(authProfileId ? { authProfileId } : {}),
      ...(resolvedAuth ? { resolvedAuth } : {}),
      ...(skipLocalCredential ? { skipLocalCredential: true } : {}),
    });
  }
  let store: AuthProfileStore | undefined;
  let materializedProfile:
    | { profileId: string; credential: AuthProfileStore["profiles"][string] }
    | undefined;
  if (authProfileId) {
    store = await loadRouteAuthProfileStore(route);
    const credential = store.profiles[authProfileId];
    if (!credential) {
      return undefined;
    }
    if (credential.type === "oauth") {
      return fingerprintAuthProfileCredential({
        profileId: authProfileId,
        credential,
      });
    }
    if (route.agentHarnessRuntimeOverride !== "openclaw") {
      const harnessId = route.agentHarnessRuntimeOverride;
      const harness = getRegisteredAgentHarness(harnessId)?.harness;
      if (harness?.authBootstrap === "harness") {
        const input = {
          harnessId,
          authProfileId,
          authProfileStore: store,
          agentDir: route.agentDir,
          config: route.runConfig,
        };
        return getRegisteredAgentHarness(harnessId)?.harness.authBinding?.fingerprint(input);
      }
      materializedProfile = {
        profileId: authProfileId,
        credential,
      };
    }
  }
  // Credential selection is transport-sensitive. Reuse the facts from the
  // successful run so this authority hot path cannot pick a different owner.
  if (!modelId || !modelApi) {
    return undefined;
  }
  const auth = await resolveApiKeyForProviderCore({
    store,
    provider: route.provider,
    cfg: route.runConfig,
    agentDir: route.agentDir,
    workspaceDir: resolveAgentWorkspaceDir(route.runConfig, route.agentId, process.env),
    ...(authProfileId
      ? { profileId: authProfileId, lockedProfile: true as const }
      : { allowAuthProfileFallback: false }),
    modelId,
    modelApi,
    secretSentinels: materializedProfile === undefined,
  });
  if (authProfileId && auth.profileId !== authProfileId) {
    return undefined;
  }
  if (materializedProfile) {
    return auth.apiKey
      ? fingerprintResolvedAuthProfileCredential({ ...materializedProfile, resolvedAuth: auth })
      : undefined;
  }
  return fingerprintResolvedProviderAuth(auth);
}

export async function createSystemAgentVerifiedInferenceBinding(params: {
  configuredRoute: SystemAgentConfiguredRoute;
  executionRoute: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const runConfig = cloneConfigWithResolutionFacts(params.executionRoute.runConfig);
  const configuredExecution = {
    ...params.executionRoute,
    sourceConfig: cloneConfigWithResolutionFacts(params.executionRoute.sourceConfig),
    runConfig,
  } as SystemAgentConfiguredRoute;
  const authProfileId = params.auth.authProfileId ?? configuredExecution.authProfileId;
  const modelId = params.auth.modelId?.trim();
  const modelApi = params.auth.modelApi?.trim();
  if (authProfileId) {
    configuredExecution.authProfileId = authProfileId;
  }
  const proofKind = params.auth.runtimeOwnerFingerprint ? "runtime-owner" : "credential";
  if (
    (params.auth.authFingerprint && params.auth.runtimeOwnerFingerprint) ||
    (!params.auth.authFingerprint && !params.auth.runtimeOwnerFingerprint)
  ) {
    throw new Error("The successful inference run did not report one exact execution owner.");
  }
  const runtimeOwnerId = params.auth.runtimeOwnerId?.trim();
  if (proofKind === "runtime-owner" && (!params.auth.runtimeOwnerKind || !runtimeOwnerId)) {
    throw new Error("The successful inference run did not report its exact runtime owner.");
  }
  let successfulHarnessId: string | undefined;
  if (configuredExecution.runner === "embedded") {
    const configuredHarnessId = configuredExecution.agentHarnessRuntimeOverride?.trim();
    const reportedHarnessId = params.auth.agentHarnessId?.trim();
    if ((!configuredHarnessId || configuredHarnessId === "auto") && !reportedHarnessId) {
      throw new Error("The successful inference run did not report its exact agent harness.");
    }
    if (
      reportedHarnessId &&
      configuredHarnessId &&
      configuredHarnessId !== "auto" &&
      reportedHarnessId !== configuredHarnessId
    ) {
      throw new Error(
        `The successful inference run used agent harness "${reportedHarnessId}" instead of "${configuredHarnessId}".`,
      );
    }
    successfulHarnessId = reportedHarnessId ?? configuredHarnessId;
  }
  const execution =
    configuredExecution.runner === "embedded"
      ? ({
          ...configuredExecution,
          agentHarnessRuntimeOverride: successfulHarnessId!,
        } satisfies SystemAgentVerifiedExecutionRoute)
      : configuredExecution;
  let currentRuntimeArtifactFingerprint: string | undefined;
  if (execution.runner === "cli") {
    if (!params.auth.runtimeArtifactFingerprint || !params.auth.runtimeArtifactId?.trim()) {
      throw new Error("The successful CLI inference run did not report its runtime artifact.");
    }
    currentRuntimeArtifactFingerprint = await resolveCliRuntimeArtifactFingerprint({
      provider: execution.provider,
      config: execution.runConfig,
      agentId: execution.agentId,
      runtimeArtifactId: params.auth.runtimeArtifactId.trim(),
    });
    if (currentRuntimeArtifactFingerprint !== params.auth.runtimeArtifactFingerprint) {
      throw new Error("The successful CLI runtime artifact is no longer active.");
    }
  }
  const pluginHarnessId =
    execution.runner === "embedded" && successfulHarnessId !== "openclaw"
      ? successfulHarnessId
      : undefined;
  if (pluginHarnessId) {
    if (
      params.auth.runtimeOwnerKind !== "plugin-harness" ||
      runtimeOwnerId !== pluginHarnessId ||
      !params.auth.runtimeArtifactId?.trim() ||
      !params.auth.runtimeArtifactFingerprint
    ) {
      throw new Error(
        "The successful inference harness did not report its exact runtime artifact.",
      );
    }
    const artifact = {
      id: params.auth.runtimeArtifactId.trim(),
      fingerprint: params.auth.runtimeArtifactFingerprint,
    };
    if (!(await validateAgentHarnessRuntimeArtifact({ harnessId: pluginHarnessId, artifact }))) {
      throw new Error("The successful inference harness runtime artifact is no longer active.");
    }
    currentRuntimeArtifactFingerprint = artifact.fingerprint;
  }
  // The operation owner supplies the refreshed live or staged route. Do not
  // substitute on-disk credentials for an unsaved candidate here.
  const currentAuthFingerprint = await resolveExecutionAuthFingerprint(
    execution,
    { ...params.auth, authProfileId, modelId, modelApi },
    proofKind,
    currentRuntimeArtifactFingerprint,
  );
  const reportedAuthFingerprint =
    params.auth.authFingerprint ?? params.auth.runtimeOwnerFingerprint;
  if (!currentAuthFingerprint || reportedAuthFingerprint !== currentAuthFingerprint) {
    throw new Error("The successful inference credential is no longer the active route owner.");
  }
  if (
    pluginHarnessId &&
    resolveRouteHarnessOwnerPluginIds(params.configuredRoute.sourceConfig, execution).length === 0
  ) {
    throw new Error("The successful inference harness has no trusted manifest owner.");
  }
  const ownerPluginArtifactSnapshot = captureSystemAgentOwnerPluginArtifacts({
    config: params.configuredRoute.sourceConfig,
    executionRoute: execution,
  });
  const { ownerPluginIds, ownerPluginArtifacts } = ownerPluginArtifactSnapshot;
  return {
    configuredRoute: systemAgentRouteIdentity(params.configuredRoute),
    execution,
    executionFingerprint: await projectVerifiedExecutionFingerprint(
      params.configuredRoute.sourceConfig,
      execution,
      ownerPluginIds,
    ),
    ownerPluginIds,
    ownerPluginArtifacts,
    auth: {
      ...(authProfileId ? { authProfileId } : {}),
      ...(successfulHarnessId ? { agentHarnessId: successfulHarnessId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(modelApi ? { modelApi } : {}),
      authFingerprint: currentAuthFingerprint,
      ...(proofKind === "runtime-owner" ? { proofKind } : {}),
      ...(params.auth.runtimeOwnerKind ? { runtimeOwnerKind: params.auth.runtimeOwnerKind } : {}),
      ...(runtimeOwnerId ? { runtimeOwnerId } : {}),
      ...(params.auth.runtimeArtifactFingerprint
        ? { runtimeArtifactFingerprint: params.auth.runtimeArtifactFingerprint }
        : {}),
      ...(params.auth.runtimeArtifactId
        ? { runtimeArtifactId: params.auth.runtimeArtifactId.trim() }
        : {}),
      ...(params.auth.skipLocalCredential ? { skipLocalCredential: true } : {}),
    },
  };
}

/** Re-hash plugin-owned runtime files only at a persistent side-effect boundary. */
export async function hasCurrentSystemAgentOwnerPluginArtifacts(
  binding: SystemAgentVerifiedInferenceBinding,
  capturedSnapshot?: ConfigFileSnapshot,
): Promise<boolean> {
  const snapshot =
    capturedSnapshot ?? (await (await import("../config/config.js")).readConfigFileSnapshot());
  if (!snapshot.exists || !snapshot.valid) {
    return false;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  try {
    const ownerPluginIds = resolveRouteOwnerPluginIds(config, binding.execution);
    if (!isDeepStrictEqual(ownerPluginIds, binding.ownerPluginIds)) {
      return false;
    }
    return isDeepStrictEqual(
      projectOwnerPluginArtifacts({
        config,
        route: binding.execution,
        ownerPluginIds,
      }),
      binding.ownerPluginArtifacts,
    );
  } catch {
    return false;
  }
}

/**
 * Re-check authored route ownership, then return only the frozen verified run.
 * Workspace/channel changes are excluded; broad plugin/env/tool config cannot
 * switch this frozen run, while relevant runtime plugin membership and the
 * actual selected credential are checked explicitly.
 */
export async function resolveSystemAgentVerifiedInferenceState(
  binding: SystemAgentVerifiedInferenceBinding,
): Promise<SystemAgentVerifiedInferenceState | null> {
  const snapshot = await (await import("../config/config.js")).readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return null;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  const currentRoute = await resolveSystemAgentConfiguredRouteFromConfig(
    config,
    binding.execution.agentId,
    undefined,
    snapshot,
  );
  if (
    !currentRoute ||
    !isDeepStrictEqual(systemAgentRouteIdentity(currentRoute), binding.configuredRoute)
  ) {
    return null;
  }
  // Keep the live-tested runner/harness selection frozen, but reproject its
  // owner through current config so policy/backend changes cannot reuse proof.
  const currentExecution: SystemAgentVerifiedExecutionRoute = {
    ...binding.execution,
    sourceConfig: currentRoute.sourceConfig,
    runConfig: currentRoute.runConfig,
  };
  let currentOwnerPluginIds: string[];
  let currentFingerprint: SystemAgentVerifiedExecutionFingerprint;
  try {
    currentOwnerPluginIds = resolveRouteOwnerPluginIds(config, currentExecution);
    if (!isDeepStrictEqual(currentOwnerPluginIds, binding.ownerPluginIds)) {
      return null;
    }
    currentFingerprint = await projectVerifiedExecutionFingerprint(
      config,
      currentExecution,
      currentOwnerPluginIds,
    );
  } catch {
    return null;
  }
  if (!isDeepStrictEqual(currentFingerprint, binding.executionFingerprint)) {
    return null;
  }
  if (
    binding.execution.runner === "embedded" &&
    binding.auth.agentHarnessId !== binding.execution.agentHarnessRuntimeOverride
  ) {
    return null;
  }
  let currentRuntimeArtifactFingerprint: string | undefined;
  if (binding.execution.runner === "cli") {
    currentRuntimeArtifactFingerprint = await resolveCliRuntimeArtifactFingerprint({
      provider: currentExecution.provider,
      config: currentExecution.runConfig,
      agentId: currentExecution.agentId,
      runtimeArtifactId: binding.auth.runtimeArtifactId,
    }).catch(() => undefined);
    if (currentRuntimeArtifactFingerprint !== binding.auth.runtimeArtifactFingerprint) {
      return null;
    }
  } else if (
    binding.execution.runner === "embedded" &&
    binding.execution.agentHarnessRuntimeOverride !== "openclaw"
  ) {
    const harnessId = binding.execution.agentHarnessRuntimeOverride;
    const artifactId = binding.auth.runtimeArtifactId?.trim();
    const artifactFingerprint = binding.auth.runtimeArtifactFingerprint;
    if (!harnessId || !artifactId || !artifactFingerprint) {
      return null;
    }
    if (
      !(await validateAgentHarnessRuntimeArtifact({
        harnessId,
        artifact: { id: artifactId, fingerprint: artifactFingerprint },
      }))
    ) {
      return null;
    }
    currentRuntimeArtifactFingerprint = artifactFingerprint;
  }
  const currentAuthFingerprint = await resolveExecutionAuthFingerprint(
    currentExecution,
    binding.auth,
    binding.auth.proofKind,
    currentRuntimeArtifactFingerprint,
  ).catch(() => undefined);
  if (currentAuthFingerprint !== binding.auth.authFingerprint) {
    return null;
  }
  return { config, route: binding.execution };
}

export async function resolveSystemAgentVerifiedInferenceRoute(
  binding: SystemAgentVerifiedInferenceBinding,
): Promise<SystemAgentVerifiedExecutionRoute | null> {
  return (await resolveSystemAgentVerifiedInferenceState(binding))?.route ?? null;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
