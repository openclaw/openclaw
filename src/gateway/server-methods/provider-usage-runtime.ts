// Prepared provider-usage discovery and credential ownership for Gateway status RPCs.
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import {
  ensureAuthProfileStoreAsync,
  externalCliDiscoveryForConfigStatus,
  getRuntimeAuthProfileStoreSnapshotRevision,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintResolvedProviderAuth,
} from "../../agents/execution-auth-binding.js";
import { resolveLegacyInheritedAuthAgentId } from "../../agents/legacy-inherited-auth-dir.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { listProviderUsagePluginDescriptors } from "../../plugins/provider-runtime.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";

type ResolvedDirectApiKey = { apiKey: string; source: string };

type ProviderUsageRuntimeSnapshot = {
  agentDir: string;
  agentId: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  store: AuthProfileStore;
};

type ProviderUsageRuntimeGeneration = ProviderUsageRuntimeSnapshot & {
  authStoreGeneration: number;
  pluginRegistryGeneration: number;
};

let current: ProviderUsageRuntimeGeneration | undefined;

function sortedRecordEntries<T>(value: Record<string, T> | undefined) {
  return Object.entries(value ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
}

export function clearProviderUsageRuntimeSnapshot(): void {
  current = undefined;
}

export async function getProviderUsageRuntimeSnapshot(params: {
  config: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  store?: AuthProfileStore;
}): Promise<ProviderUsageRuntimeSnapshot> {
  const agentId = params.agentId ?? resolveLegacyInheritedAuthAgentId(params.config);
  const agentDir = params.agentDir ?? resolveAgentDir(params.config, agentId);
  // Config publication replaces the object, so identity is the exact mutation signal.
  const configRef = params.config;
  // Registry publication owns descriptor lifetime; request paths only compare its O(1) counter.
  const pluginRegistryGeneration = getActivePluginRegistryVersion();
  // Auth writers and runtime overlay publishers advance this O(1) process generation.
  const authStoreGeneration = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
  if (
    current?.configRef === configRef &&
    // Prepared owners can advance before the ambient snapshot; their exact store fences reuse.
    (params.store === undefined || current.store === params.store) &&
    current.agentDir === agentDir &&
    current.agentId === agentId &&
    current.pluginRegistryGeneration === pluginRegistryGeneration &&
    current.authStoreGeneration === authStoreGeneration
  ) {
    return current;
  }

  const store =
    params.store ??
    (await ensureAuthProfileStoreAsync(agentDir, {
      externalCli: externalCliDiscoveryForConfigStatus({ cfg: configRef }),
    }));
  const descriptors = listProviderUsagePluginDescriptors({ config: configRef, env: process.env });
  const providerIds = descriptors.map((descriptor) => descriptor.provider);
  const directApiKeys = new Map<string, ResolvedDirectApiKey>();
  for (const provider of providerIds) {
    const resolved =
      resolveUsableCustomProviderApiKey({ cfg: configRef, provider, env: process.env }) ??
      resolveEnvApiKey(provider, process.env, { config: configRef });
    if (!resolved) {
      continue;
    }
    directApiKeys.set(provider, resolved);
  }
  const profiles = sortedRecordEntries(store.profiles).map(([profileId, credential]) => {
    const fingerprint =
      fingerprintAuthProfileCredential({ profileId, credential }) ??
      fingerprintAuthProfileOwnerShape({ profileId, credential });
    return fingerprint ?? `${profileId}:${credential.type}:${credential.provider}`;
  });
  const direct = [...directApiKeys]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([provider, resolved]) => [
      provider,
      fingerprintResolvedProviderAuth({ ...resolved, mode: "api-key" }) ?? null,
    ]);
  const selectedProfiles = providerIds.map((provider) => [
    provider,
    resolveAuthProfileOrder({ cfg: configRef, store, provider }),
  ]);
  current = {
    agentDir,
    agentId,
    configRef,
    // Profile selection can switch accounts without changing the profile set.
    // Record its resolved order so routine bookkeeping writes do not invalidate
    // usage while a real account-selection change still does.
    credentialKey: JSON.stringify({
      profiles,
      direct,
      order: sortedRecordEntries(store.order),
      lastGood: sortedRecordEntries(store.lastGood),
      selectedProfiles,
    }),
    providerIds,
    store,
    // Building can publish an external-auth overlay, so bind the finished snapshot to its result.
    authStoreGeneration: getRuntimeAuthProfileStoreSnapshotRevision(agentDir),
    pluginRegistryGeneration,
  };
  return current;
}
