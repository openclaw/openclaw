import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../secrets/runtime-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { attachProviderAuthAuthority } from "./provider-auth-authority.js";
import type { ProviderSyntheticAuthResult } from "./provider-external-auth.types.js";
import { getProviderOwnerIndex } from "./provider-owner-index.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-state.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

export type ProviderAuthScopeLookup = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
};

export function pluginProviderAuthUnavailable(provider: string, reason: string): ProviderAuthError {
  return new ProviderAuthError(
    "missing-provider-auth",
    provider,
    `Plugin-owned auth for provider "${provider}" is unavailable: ${reason}.`,
  );
}

/** Static ownership survives absent/disabled executables in the selected metadata generation. */
export function resolveProviderAuthScope(params: ProviderAuthScopeLookup): "agent" | "plugin" {
  const snapshot =
    params.pluginMetadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    });
  const registry =
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const context = registry ? getPluginRuntimeLoadContext(registry) : undefined;
  const manifests = snapshot?.manifestRegistry ?? context?.manifestRegistry;
  if (!manifests) {
    return "agent";
  }
  const scope = getProviderOwnerIndex(manifests).authScopes.get(
    normalizeProviderId(params.provider),
  );
  if (scope === "conflict") {
    throw pluginProviderAuthUnavailable(params.provider, "conflicting static credential owners");
  }
  return scope ?? "agent";
}

/** Plugin credentials are live instance-owned facts, never prepared/restored bearer cache entries. */
export function resolvePluginOwnedProviderAuthWith(
  params: ProviderAuthScopeLookup & { profileId?: string; preferredProfile?: string },
  resolveProviderRuntimePlugin: (
    params: ProviderAuthScopeLookup & { applyAutoEnable: false },
  ) => ProviderPlugin | undefined,
) {
  if (resolveProviderAuthScope(params) !== "plugin") {
    throw pluginProviderAuthUnavailable(
      params.provider,
      "static metadata does not grant plugin credential scope",
    );
  }
  if (params.profileId !== undefined || params.preferredProfile !== undefined) {
    throw pluginProviderAuthUnavailable(
      params.provider,
      "agent profile pins cannot select plugin credentials",
    );
  }
  const lookup = { ...params, applyAutoEnable: false as const };
  const provider = resolveProviderRuntimePlugin(lookup);
  const hook = provider?.resolveSyntheticAuth;
  const instance = hook ? getPluginValueInstance(hook) : undefined;
  const owner = instance?.owner;
  const registry = owner?.registry;
  const registration = registry?.providers.find(
    (entry) =>
      entry.pluginId === provider?.pluginId &&
      entry.provider.id === provider?.id &&
      entry.provider.resolveSyntheticAuth === hook,
  );
  if (!provider || provider.authScope !== "plugin" || !hook || !instance || !registration) {
    throw pluginProviderAuthUnavailable(
      params.provider,
      "selected live resolveSyntheticAuth owner is missing",
    );
  }
  const registeredProvider = registration.provider;
  const revision = getActiveSecretsRuntimeSnapshotRevisionState();
  const assertCurrent = () => {
    if (
      !instance.acceptingCalls ||
      instance.owner !== owner ||
      owner?.revoked ||
      instance.lifecycle.signal.aborted ||
      instance.pluginId !== provider.pluginId ||
      !owner?.record.enabled ||
      owner.record.status !== "loaded" ||
      owner.registry !== registry ||
      getActiveSecretsRuntimeSnapshotRevisionState() !== revision ||
      !registry?.providers.includes(registration) ||
      registration.provider !== registeredProvider ||
      registeredProvider.authScope !== "plugin" ||
      registeredProvider.resolveSyntheticAuth !== hook
    ) {
      throw pluginProviderAuthUnavailable(
        params.provider,
        "credential owner was retired or replaced",
      );
    }
  };
  assertCurrent();
  const result = instance.run((): ProviderSyntheticAuthResult | undefined => {
    const resolved = hook({
      config: params.config,
      provider: params.provider,
      // models.providers credentials belong to a different physical owner.
      providerConfig: undefined,
    });
    if (!resolved) {
      return undefined;
    }
    // Read accessor-backed results within the exact invocation, then fence the complete read.
    const { apiKey, source, mode, expiresAt, nativeAuth } = resolved;
    return {
      apiKey,
      source,
      mode,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(nativeAuth ? { nativeAuth: { runtime: nativeAuth.runtime, mode: nativeAuth.mode } } : {}),
    };
  });
  assertCurrent();
  if (!result?.apiKey?.trim()) {
    throw pluginProviderAuthUnavailable(
      params.provider,
      "live credential or no-auth evidence is missing",
    );
  }
  return attachProviderAuthAuthority(result, assertCurrent);
}
