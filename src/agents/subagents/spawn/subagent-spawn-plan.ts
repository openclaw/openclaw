/**
 * Subagent spawn planning helpers.
 *
 * Resolves model, thinking, and timeout choices before the sessions_spawn executor launches work.
 */
import { formatThinkingLevels } from "../../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agent-scope.js";
import { splitTrailingAuthProfile } from "../../model-ref-profile.js";
import {
  type ModelRef,
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
} from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

/** Splits a provider/model ref while preserving model-only refs. */
export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

/** Resolves the effective subagent run timeout from per-call override or config default. */
export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

/** Resolves the subagent model plus thinking patch to apply to the spawned session. */
export async function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  inheritedModel?: ModelRef;
  fastMode?: FastMode;
  workspaceDir?: string;
  requiresTools?: boolean;
}) {
  const { model: rawResolvedModel, resolvedModel: inheritedModel } =
    resolveSubagentSpawnModelSelection({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      modelOverride: params.modelOverride,
      inheritedModel: params.inheritedModel,
    });
  const { model: requestedModel, profile: authProfileId } =
    splitTrailingAuthProfile(rawResolvedModel);

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    requesterAgentConfig: params.requesterAgentConfig,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    callerThinkingRaw: params.callerThinkingRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(requestedModel);
    // The hint is provider/model-specific because valid thinking levels vary by backend.
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel: requestedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  const modelOverrideSource = params.modelOverride?.trim() ? "user" : "auto";
  let choice;
  try {
    choice = await getSubagentSpawnDeps().prepareModelChoice({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      workspaceDir: params.workspaceDir,
      raw: rawResolvedModel,
      source: modelOverrideSource === "user" ? "override" : "automatic",
      ...(inheritedModel ? { resolvedRef: inheritedModel } : {}),
      ...(modelOverrideSource === "auto"
        ? {
            fallbacks: modelFallbackOverrideFromAvailability(
              resolveModelFallbackAvailability({
                cfg: params.cfg,
                agentId: params.targetAgentId,
                hasSessionModelOverride: true,
                modelOverrideSource: "auto",
                subagentSpawnLineage: true,
              }),
            ),
          }
        : {}),
    });
  } catch (error) {
    return {
      status: "error" as const,
      resolvedModel: requestedModel,
      error: `sessions_spawn could not verify the selected model: ${summarizeSpawnError(error)}`,
    };
  }
  if (choice.kind === "unavailable") {
    return {
      status: "error" as const,
      resolvedModel: requestedModel,
      error: `sessions_spawn model "${requestedModel}" is not usable: ${choice.error}`,
    };
  }
  const resolvedModel = `${choice.ref.provider}/${choice.ref.model}`;
  if (params.requiresTools && choice.kind === "resolved" && !supportsModelTools(choice.model)) {
    return {
      status: "error" as const,
      resolvedModel,
      error: `sessions_spawn outputSchema requires a tool-capable target model; "${resolvedModel}" declares compat.supportsTools=false.`,
    };
  }
  const hasSelectedAutoModel =
    modelOverrideSource === "auto" &&
    Boolean(
      params.inheritedModel ??
      resolveSubagentConfiguredModelSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
      }),
    );
  const modelOrigin = hasSelectedAutoModel ? choice.ref : undefined;

  return {
    status: "ok" as const,
    resolvedModel,
    ...(inheritedModel ? { inheritedModel: choice.ref } : {}),
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel
        ? {
            model: resolvedModel,
            modelOverrideSource,
            ...(modelOrigin
              ? {
                  // Selected child models are session overrides, not legacy fallback residue.
                  // Self-origin metadata keeps cleanup from discarding them before first use.
                  modelOverrideFallbackOriginProvider: modelOrigin.provider,
                  modelOverrideFallbackOriginModel: modelOrigin.model,
                }
              : {}),
          }
        : {}),
      ...(authProfileId
        ? {
            authProfileOverride: authProfileId,
            authProfileOverrideSource: "user" as const,
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
      ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    },
  };
}
