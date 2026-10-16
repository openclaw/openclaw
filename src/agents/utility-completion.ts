import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { formatAgentRuntimeName } from "../status/agent-runtime-label.js";
import { assertOperatorModelAllowed } from "./admitted-run-context.js";
import {
  resolveIsolatedCompletionRuntime,
  resolveIsolatedCompletionProvider,
} from "./isolated-completion-route.js";
import type { runIsolatedCompletion } from "./isolated-completion.js";
import { hasAvailableAuthForProvider } from "./model-auth.js";
import {
  prepareModelCatalogDecisions,
  type ModelCatalogDecisionParams,
} from "./model-catalog-decisions.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";
import { resolveAutomaticUtilityRuntimeOverride } from "./utility-model.js";

export type UtilityCompletionAttempt = Pick<
  Parameters<typeof runIsolatedCompletion>[0],
  "provider" | "model" | "authProfileId"
>;

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
    thinkLevel: "off" as const,
    agentId: params.agentId,
    agentDir: selection.agentDir,
    ...(params.useUtilityModel ? { useUtilityModel: true as const } : {}),
    ...(inheritedRuntime ? { agentHarnessRuntimeOverride: inheritedRuntime } : {}),
  };
}

/** Utility calls share ordinary retry classification without inheriting the main model chain. */
export async function runUtilityCompletion(
  params: Parameters<typeof runIsolatedCompletion>[0] & {
    useUtilityModel?: boolean;
    onAttempt?: (attempt: UtilityCompletionAttempt) => void;
  },
  run?: typeof runIsolatedCompletion,
) {
  const { onAttempt, ...request } = params;
  const complete = run ?? (await import("./isolated-completion.js")).runIsolatedCompletion;
  const attempt = (candidate: Parameters<typeof runIsolatedCompletion>[0]) => {
    onAttempt?.(candidate);
    return complete(candidate);
  };
  const utility = params.useUtilityModel
    ? readUtilityModelSetting(params.config ?? {}, params.agentId)
    : undefined;
  const fallbacks = utility?.kind === "disabled" ? undefined : utility?.fallbacks;
  if (!fallbacks?.length) {
    if (params.useUtilityModel) {
      assertOperatorModelAllowed(params.operatorAuthority, {
        provider: params.provider,
        model: params.model,
      });
    }
    return await attempt(request);
  }
  const { runWithModelFallback } = await import("./model-fallback-runner.js");
  const result = await runWithModelFallback({
    cfg: params.config,
    agentId: params.agentId,
    agentDir: params.agentDir,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    fallbacksOverride: fallbacks,
    abortSignal: params.abortSignal,
    operatorAuthority: params.operatorAuthority,
    resolveAgentHarnessRuntimeOverride: (provider, model) =>
      provider === params.provider && model === params.model
        ? params.agentHarnessRuntimeOverride
        : undefined,
    // Isolated completion already owns credential selection and profile rotation.
    skipAuthProfileRuntime: true,
    run: (provider, model, options) =>
      attempt({
        ...request,
        provider,
        model,
        ...(options?.modelRoutingProvenance.stage === "fallback"
          ? {
              authProfileId: provider === params.provider ? params.authProfileId : undefined,
              agentHarnessRuntimeOverride: undefined,
            }
          : {}),
      }),
  });
  return result.result;
}

/** Keep visible-text retry/fallback in callers; the runtime owns authentication. */
export async function prepareUtilityCompletionForAgent(
  params: Parameters<typeof resolveUtilityCompletionForAgent>[0],
) {
  const prepared = resolveUtilityCompletionForAgent(params);
  if (
    prepared.agentHarnessRuntimeOverride &&
    prepared.agentHarnessRuntimeOverride !== "claude-cli" &&
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
      const decisions = await prepareModelCatalogDecisions({
        ...params,
        preferredProfileId: prepared.authProfileId,
        pinnedProfileId: prepared.authProfileId,
        profileProvider: provider,
      });
      if (
        prepared.agentHarnessRuntimeOverride &&
        prepared.agentHarnessRuntimeOverride !== "claude-cli"
      ) {
        const direct = decisions.evaluateEntry(entry, params.snapshot.routeVariants, "openclaw");
        if (direct.availability === true) {
          delete prepared.agentHarnessRuntimeOverride;
        }
      }
      const runtime = await resolveIsolatedCompletionRuntime({
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
