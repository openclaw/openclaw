import { hasAvailableAuthForProvider } from "./model-auth.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";
import { resolveAutomaticUtilityRuntimeOverride } from "./utility-model.js";

/** Keep visible-text retry/fallback in callers; the runtime owns authentication. */
export async function prepareUtilityCompletionForAgent(
  params: Parameters<typeof resolveSimpleCompletionSelectionForAgent>[0] & {
    preferredProfile?: string;
  },
) {
  const selection = resolveSimpleCompletionSelectionForAgent(params);
  if (!selection) {
    throw new Error(`No utility model configured for agent ${params.agentId}.`);
  }
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
  const authProfileId = selection.profileId ?? params.preferredProfile;
  // Preserve working HTTP routes and their billing. Only probe credentials when
  // automatic selection could borrow the primary's model-scoped runtime.
  const agentHarnessRuntimeOverride =
    inheritedRuntime &&
    !(await hasAvailableAuthForProvider({
      provider: selection.provider,
      cfg: params.cfg,
      modelId: selection.modelId,
      agentDir: selection.agentDir,
      preferredProfile: authProfileId,
    }))
      ? inheritedRuntime
      : undefined;
  return {
    config: params.cfg,
    provider: selection.provider,
    model: selection.modelId,
    authProfileId,
    outputTextPolicy: "strict-visible" as const,
    agentId: params.agentId,
    agentDir: selection.agentDir,
    ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
  };
}
