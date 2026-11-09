import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  captureAuthProfileOwnerScope,
  prepareSharedAuthStoreOwnership,
} from "../../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthLoginTarget } from "../../agents/auth-profiles/shared-login-target.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginProvidersCore } from "../../plugins/providers.runtime.js";
import {
  resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry,
} from "../../plugins/setup-registry.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { normalizeManualAuthProvider } from "./auth-manual-input.js";
import { loadValidConfigSnapshotOrThrow, resolveModelsTargetAgent } from "./shared.js";

export type ResolvedModelsAuthContext = Awaited<ReturnType<typeof resolveModelsAuthContext>>;

export async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
  rawAgentId?: string | null;
  config?: OpenClawConfig;
  ownerPluginId?: string;
  sharedLogin?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const configSnapshot = await loadValidConfigSnapshotOrThrow();
  const config = params?.config ?? configSnapshot.runtimeConfig;
  if (
    params?.sharedLogin &&
    params.rawAgentId?.trim() === "main" &&
    config.agents?.defaults?.authInheritance?.agentId?.trim() === "main" &&
    !listAgentIds(config).includes("main")
  ) {
    await prepareSharedAuthStoreOwnership(params.env);
  }
  const sharedTarget = params?.sharedLogin
    ? resolveSharedMainAuthLoginTarget(config, params.rawAgentId, params.env)
    : undefined;
  if (sharedTarget) {
    const selectedOwner = captureAuthProfileOwnerScope(params?.env);
    const processOwner = captureAuthProfileOwnerScope();
    if (
      selectedOwner.stateDir !== processOwner.stateDir ||
      selectedOwner.sharedMainDir !== processOwner.sharedMainDir
    ) {
      throw new Error(
        "Shared credential sign-in must run on the intended Gateway or state owner. Invoke the native login there.",
      );
    }
  }
  const { agentId, agentDir } =
    sharedTarget ??
    resolveModelsTargetAgent(config, params?.rawAgentId ?? undefined, {
      kind: "mutation",
    });
  const contextAgentId = sharedTarget
    ? resolveModelsTargetAgent(config, undefined, { kind: "read" }).agentId
    : agentId;
  const workspaceDir = resolveAgentWorkspaceDir(config, contextAgentId, params?.env);
  const requestedProvider = params?.requestedProvider?.trim();
  const providerRef = requestedProvider
    ? normalizeManualAuthProvider(requestedProvider)
    : undefined;
  // Auth setup also runs inside the Gateway; discovery must not replace its live registry.
  const providers = resolvePluginProvidersCore({
    config,
    workspaceDir,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    ...(params?.ownerPluginId ? { onlyPluginIds: [params.ownerPluginId] } : {}),
    ...(providerRef ? { providerRefs: [providerRef] } : {}),
  });
  const ownerPluginId = params?.ownerPluginId;
  let authProviders: ProviderPlugin[];
  if (!ownerPluginId && providerRef) {
    const setupProvider = resolvePluginSetupProviderCore({
      provider: providerRef,
      config,
      workspaceDir,
    });
    authProviders = setupProvider ? [setupProvider] : [...providers];
  } else {
    const setupProviders = resolvePluginSetupRegistry({
      config,
      workspaceDir,
      ...(ownerPluginId ? { pluginIds: [ownerPluginId] } : {}),
    }).providers.map((entry) => entry.provider);
    const setupById = new Map(
      setupProviders.map((provider) => [normalizeProviderId(provider.id), provider] as const),
    );
    const existing = new Set(providers.map((provider) => normalizeProviderId(provider.id)));
    authProviders = [
      ...providers.map((provider) => setupById.get(normalizeProviderId(provider.id)) ?? provider),
      ...setupProviders.filter((provider) => !existing.has(normalizeProviderId(provider.id))),
    ];
  }
  return {
    config,
    configSnapshot,
    sharedCredentialOnly: Boolean(sharedTarget),
    agentId,
    agentDir,
    workspaceDir,
    providers: authProviders,
  };
}
