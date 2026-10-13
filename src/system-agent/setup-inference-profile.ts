import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";

/** A pinned profile must exist and belong to the route before any request leaves the host. */
export function resolveSetupInferenceProfileError(
  route: SystemAgentConfiguredRoute,
  workspaceDir: string,
  deps: ActivateSetupInferenceDeps,
): string | undefined {
  const profileId = route.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const loadStore = deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const store = loadStore(route.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: route.runConfig,
    externalCliProviderIds: [route.provider],
  });
  const credential = store.profiles[profileId];
  if (!credential) {
    return `No credentials found for the configured setup profile "${profileId}".`;
  }
  if (route.runner === "embedded") {
    const authPlan = buildAgentRuntimeAuthPlan({
      provider: route.provider,
      authProfileProvider: credential.provider,
      authProfileMode: credential.type,
      sessionAuthProfileId: profileId,
      config: route.runConfig,
      workspaceDir,
      harnessId: route.agentHarnessRuntimeOverride,
      harnessRuntime: route.agentHarnessRuntimeOverride,
      allowHarnessAuthProfileForwarding: true,
    });
    if (authPlan.forwardedAuthProfileId === profileId) {
      return undefined;
    }
  } else {
    const aliasContext = { config: route.runConfig, workspaceDir };
    try {
      if (
        resolveProviderIdForAuth(route.provider, aliasContext) ===
        resolveProviderIdForAuth(credential.provider, { ...aliasContext, storedCredential: true })
      ) {
        return undefined;
      }
    } catch {
      return `Could not verify that configured setup profile "${profileId}" belongs to the selected ${route.provider} inference route.`;
    }
  }
  return `Configured setup profile "${profileId}" belongs to ${credential.provider}, not the selected ${route.provider} inference route.`;
}
