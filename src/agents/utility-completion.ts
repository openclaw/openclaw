import { hasAvailableAuthForProvider } from "./model-auth.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";
import { resolveAutomaticUtilityRuntimeOverride } from "./utility-model.js";

/** Keep visible-text retry/fallback in callers; the runtime owns authentication. */
export async function prepareUtilityCompletionForAgent(
  params: Parameters<typeof resolveSimpleCompletionSelectionForAgent>[0] & {
    preferredProfile?: string;
    /** Credential probe seam; defaults to the real provider auth lookup. */
    hasProviderAuth?: typeof hasAvailableAuthForProvider;
  },
) {
  const selection = resolveSimpleCompletionSelectionForAgent(params);
  if (!selection) {
    throw new Error(`No utility model configured for agent ${params.agentId}.`);
  }
  // An automatically derived small model carries no model entry of its own, so
  // it resolves the default HTTP route even when the primary pins a CLI runtime.
  // This is keyed on the resolved selection rather than on an absent modelRef:
  // the session observer passes the already-derived ref back in, so gating on
  // `!modelRef` would skip the very path that reported this. The helper still
  // confirms the selection is the derived model, so an explicitly selected
  // same-provider ref keeps its own route.
  const inheritedRuntime = params.useUtilityModel
    ? resolveAutomaticUtilityRuntimeOverride({
        cfg: params.cfg,
        agentId: params.agentId,
        utilityProvider: selection.provider,
        utilityModelId: selection.modelId,
        ...(params.manifestPlugins
          ? {
              metadataSnapshot:
                "plugins" in params.manifestPlugins
                  ? params.manifestPlugins
                  : { plugins: params.manifestPlugins },
            }
          : {}),
      })
    : undefined;
  // The pinned runtime is a fallback for a derived model that cannot authenticate
  // itself, not a migration of working HTTP utility calls onto CLI subscription
  // quota. An installation holding both a provider credential and a CLI-backed
  // primary keeps its existing HTTP route; only a derived model with no usable
  // credential borrows the primary's runtime, which is exactly the case that
  // otherwise fails with "No API key found for provider". The probe runs only
  // when a runtime would otherwise be inherited, so the common path is unchanged.
  //
  // The decision is per preparation. A caller that retains a prepared completion,
  // as the session observer does for the life of one observer run, keeps the route
  // it was prepared with until it re-prepares; a credential added mid-run is picked
  // up then, not immediately.
  const agentHarnessRuntimeOverride =
    inheritedRuntime &&
    !(await (params.hasProviderAuth ?? hasAvailableAuthForProvider)({
      provider: selection.provider,
      cfg: params.cfg,
      modelId: selection.modelId,
      ...(selection.agentDir ? { agentDir: selection.agentDir } : {}),
      ...((selection.profileId ?? params.preferredProfile)
        ? { preferredProfile: selection.profileId ?? params.preferredProfile }
        : {}),
    }))
      ? inheritedRuntime
      : undefined;
  return {
    config: params.cfg,
    provider: selection.provider,
    model: selection.modelId,
    authProfileId: selection.profileId ?? params.preferredProfile,
    outputTextPolicy: "strict-visible" as const,
    agentId: params.agentId,
    agentDir: selection.agentDir,
    ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
  };
}
