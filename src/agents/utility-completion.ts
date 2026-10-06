import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { formatAgentRuntimeName } from "../status/agent-runtime-label.js";
import {
  resolveIsolatedCompletionRuntime,
  resolveIsolatedCompletionProvider,
} from "./isolated-completion-route.js";
import { hasAvailableAuthForProvider } from "./model-auth.js";
import {
  createModelCatalogDecisions,
  type ModelCatalogDecisionParams,
} from "./model-catalog-decisions.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";
import { resolveAutomaticUtilityRuntimeOverride } from "./utility-model.js";

function resolveUtilityCompletionForAgent(
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
  return {
    config: params.cfg,
    provider: selection.provider,
    model: selection.modelId,
    authProfileId: selection.profileId ?? params.preferredProfile,
    outputTextPolicy: "strict-visible" as const,
    agentId: params.agentId,
    agentDir: selection.agentDir,
    ...(inheritedRuntime ? { agentHarnessRuntimeOverride: inheritedRuntime } : {}),
  };
}

/** Keep visible-text retry/fallback in callers; the runtime owns authentication. */
export async function prepareUtilityCompletionForAgent(
  params: Parameters<typeof resolveUtilityCompletionForAgent>[0],
) {
  const prepared = resolveUtilityCompletionForAgent(params);
  // Execution may refresh credentials. A prepared catalog projection must use
  // its own captured readiness instead, or an unrelated store can change its label.
  if (
    prepared.agentHarnessRuntimeOverride &&
    (await hasAvailableAuthForProvider({
      provider: prepared.provider,
      cfg: params.cfg,
      modelId: prepared.model,
      agentDir: prepared.agentDir,
      preferredProfile: prepared.authProfileId,
    }))
  ) {
    delete prepared.agentHarnessRuntimeOverride;
  }
  return prepared;
}

/** Provider-neutral route of a utility completion, as the Gateway reports it. */
export type UtilityCompletionRuntime = {
  id: string;
  kind: "api" | "cli" | "harness";
  label: string;
};

export type UtilityCompletionRuntimeParams = Pick<
  ModelCatalogDecisionParams,
  | "cfg"
  | "agentId"
  | "agentDir"
  | "workspaceDir"
  | "metadataSnapshot"
  | "preparedAuthStore"
  | "preparedRuntimeAuthModes"
  | "preparedRuntimeAuthMaterializations"
  | "pluginRegistry"
  | "snapshot"
  | "isCurrent"
>;

/**
 * Planned utility runtime from the same prepared generation as the caller's
 * catalog. An unavailable auth plan or retired owner has no route to report.
 */
export async function resolveUtilityCompletionRuntimeForAgent(
  params: UtilityCompletionRuntimeParams,
): Promise<UtilityCompletionRuntime | undefined> {
  return await withPluginRuntimeGenerationScope(params, async () => {
    try {
      if (params.isCurrent?.() === false) {
        return undefined;
      }
      const prepared = resolveUtilityCompletionForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
        manifestPlugins: params.metadataSnapshot,
        useUtilityModel: true,
      });
      const { provider } = resolveIsolatedCompletionProvider(prepared);
      const entry = [...params.snapshot.entries, ...(params.snapshot.staticEntries ?? [])].find(
        (candidate) => candidate.provider === provider && candidate.id === prepared.model,
      );
      if (!entry) {
        return undefined;
      }
      const decisions = createModelCatalogDecisions({
        ...params,
        preferredProfileId: prepared.authProfileId,
        pinnedProfileId: prepared.authProfileId,
        profileProvider: provider,
      });
      if (prepared.agentHarnessRuntimeOverride) {
        const direct = decisions.evaluateEntry(entry, params.snapshot.routeVariants, "openclaw");
        if (direct.availability === true) {
          delete prepared.agentHarnessRuntimeOverride;
        }
      }
      const runtime = resolveIsolatedCompletionRuntime({
        ...prepared,
        agentDir: params.agentDir ?? prepared.agentDir,
        workspaceDir: params.workspaceDir,
        preparedAuth: params,
      });
      if (!runtime) {
        return undefined;
      }
      const host = decisions.evaluateEntry(entry, params.snapshot.routeVariants, runtime.id);
      const available = decisions.evaluateNative(entry, host, runtime.id).availability;
      // A selected engine is not evidence that its prepared account is usable.
      // Reuse catalog readiness, including CLI/native observations, before publishing it.
      return available === true && decisions.isCurrent()
        ? {
            id: runtime.id,
            kind: runtime.kind,
            label: formatAgentRuntimeName(runtime.id, runtime.harnessLabel),
          }
        : undefined;
    } catch {
      return undefined;
    }
  });
}
