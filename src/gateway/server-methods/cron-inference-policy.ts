import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { AuthProfileAuthorization } from "../../agents/auth-profiles/authorization-contract.js";
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import { resolveConfiguredModelFallbacks } from "../../agents/model-selection-resolve.js";
import { resolveSimpleCompletionSelectionForAgent } from "../../agents/simple-completion-selection.js";
import { resolveSessionModelOverrideSource } from "../../config/sessions/model-override-provenance.js";
import type { CronInferenceGrants } from "../../cron/inference-binding.js";
import {
  captureCronInferenceBinding,
  captureCronAlternateInferenceBinding,
} from "../../cron/inference-binding.runtime.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
} from "../../cron/isolated-agent/model-selection.js";
import { resolveCronFallbacksOverride } from "../../cron/isolated-agent/run-fallback-policy.js";
import type { CronJobCreate, CronStoredJob } from "../../cron/types.js";
import { modelKey } from "../../shared/model-key.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";

export type InferenceCaller = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "hasCurrentClientAuthority"
>;

export async function captureCronInferenceForCaller(
  params: Parameters<typeof captureCronInferenceBinding>[0],
  caller: InferenceCaller,
  alternate = false,
) {
  let selection: UserModelAccountSelection | undefined;
  let authority: AuthProfileAuthorization | undefined;
  const capture = alternate
    ? (input: Parameters<typeof captureCronInferenceBinding>[0]) => {
        if (!input.model) {
          throw new Error("An alternate model is required.");
        }
        return captureCronAlternateInferenceBinding({ ...input, model: input.model });
      }
    : captureCronInferenceBinding;
  const inferenceBinding = await capture({
    ...params,
    retainAuthorization: (captured) => {
      authority = captured;
    },
    authorizeProfile: async (profileId, inherited) => {
      // Trusted creator selections already carry their owner's permission. New
      // personal selections require the same live human authority as chat.
      if (isUserModelAuthProfileId(profileId) && !inherited) {
        selection = await preparePersonalModelAccountSelection(caller, profileId);
        return selection.assertCurrent;
      }
      return undefined;
    },
  });
  return {
    inferenceBinding,
    assertInferenceSelectionCurrent: () => {
      selection?.assertCurrent();
      authority?.assertCurrent();
    },
    disposeInferenceAuthorization: () => authority?.dispose(),
  };
}

/** Optional accounts share the primary capture owner and the caller's live commit guard. */
export async function captureCronInferencePolicyForCaller(
  params: Parameters<typeof captureCronInferenceBinding>[0],
  caller: InferenceCaller,
  job: CronJobCreate | CronStoredJob,
  primary?: Awaited<ReturnType<typeof captureCronInferenceForCaller>>,
) {
  const captures: Awaited<ReturnType<typeof captureCronInferenceForCaller>>[] = [];
  if (primary) {
    captures.push(primary);
  }
  const inferenceGrants: CronInferenceGrants = Object.create(null);
  const warnings: string[] = [];
  try {
    const owner = await resolveCronModelSelectionOwner({
      cfg: params.cfg,
      agentId: params.agentId,
      requiredAgentId: params.agentId,
    });
    const selected = await resolveCronModelSelection({
      cfg: owner.config,
      owner,
      agentConfigOverride: resolveAgentConfig(owner.config, owner.agentId),
      agentId: owner.agentId,
      agentDir: owner.agentDir,
      workspaceDir: owner.workspaceDir,
      payloadModel: params.model,
      sessionEntry: params.executionSessionEntry ?? {},
      isGmailHook: params.isGmailHook === true,
    });
    if (!selected.ok) {
      throw new Error(selected.error);
    }
    const fallbacksOverride = resolveCronFallbacksOverride({
      cfg: selected.cfgWithAgentDefaults,
      agentId: params.agentId,
      job,
      selectedModel: { provider: selected.provider, model: selected.model },
      useSubagentFallbacks: selected.useSubagentFallbacks,
      inheritDefaultFallbacksForAgentStringModel:
        selected.inheritDefaultFallbacksForAgentStringModel,
      sessionModelOverrideSource:
        selected.modelSource === "session"
          ? (resolveSessionModelOverrideSource(params.executionSessionEntry) ?? undefined)
          : undefined,
    });
    const fallbacks =
      fallbacksOverride ??
      resolveConfiguredModelFallbacks({
        cfg: selected.cfgWithAgentDefaults,
        agentId: params.agentId,
      });
    const rawModels = new Map<string, string>();
    for (const model of fallbacks) {
      const candidate = resolveSimpleCompletionSelectionForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
        modelRef: model,
      });
      if (candidate) {
        const key = modelKey(candidate.provider, candidate.modelId);
        if (!rawModels.has(key)) {
          rawModels.set(key, model);
        }
      }
    }
    const candidates = resolveModelCandidateChain({
      cfg: selected.cfgWithAgentDefaults,
      agentId: params.agentId,
      provider: selected.provider,
      model: selected.model,
      requestedRouteResolution: "resolved",
      fallbacksOverride,
    });
    for (const candidate of candidates) {
      const key = modelKey(candidate.provider, candidate.model);
      if (key === modelKey(selected.provider, selected.model)) {
        continue;
      }
      try {
        const captured = await captureCronInferenceForCaller(
          { ...params, model: rawModels.get(key) ?? key },
          caller,
          true,
        );
        captures.push(captured);
        if (captured.inferenceBinding) {
          inferenceGrants[key] = captured.inferenceBinding;
        }
      } catch (error) {
        warnings.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      inferenceBinding: primary?.inferenceBinding,
      inferenceGrants,
      inferenceWarning: warnings.length
        ? `Fallback unavailable (${warnings.join("; ")}). Review this automation's model policy after selecting an account.`
        : undefined,
      assertInferenceSelectionCurrent: () => {
        for (const capture of captures) {
          capture.assertInferenceSelectionCurrent();
        }
      },
      disposeInferenceAuthorization: () => {
        for (const capture of captures) {
          capture.disposeInferenceAuthorization();
        }
      },
    };
  } catch (error) {
    for (const capture of captures) {
      capture.disposeInferenceAuthorization();
    }
    throw error;
  }
}
