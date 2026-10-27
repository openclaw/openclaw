/** Resolves model fallback chains for isolated cron runs and preflight. */
import type { RunEntryModelResolve } from "../../agents/embedded-agent-runner/run-entry.types.js";
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import { resolveCurrentChannelTarget } from "./channel-output-policy.js";
import {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";
import { logWarn } from "./run.runtime.js";

const cronModelPreflightRuntimeLoader = createLazyImportLoader(
  () => import("./model-preflight.runtime.js"),
);

/** Prepare one channel projection for both model routing hooks and embedded execution. */
export async function prepareCronModelResolveInput(
  params: Pick<RunEntryModelResolve, "cwd" | "prompt"> & {
    cronSession: { sessionEntry: Pick<SessionEntry, "modelSelectionLocked"> };
    job: Pick<CronJob, "id">;
    trigger?: "cron" | "event";
    runSessionKey: string;
    resolvedDelivery: Pick<Parameters<typeof resolveCurrentChannelTarget>[0], "to" | "threadId"> & {
      accountId?: string;
    };
    messageChannel: string | undefined;
  },
) {
  const currentChannelId = await resolveCurrentChannelTarget({
    channel: params.messageChannel,
    to: params.resolvedDelivery.to,
    threadId: params.resolvedDelivery.threadId,
  });
  const modelResolve: RunEntryModelResolve = {
    prompt: params.prompt,
    cwd: params.cwd,
    modelSelectionLocked: params.cronSession.sessionEntry.modelSelectionLocked,
    context: {
      trigger: params.trigger === "event" ? "event" : "cron",
      jobId: params.job.id,
      ...buildAgentHookContextChannelFields({
        sessionKey: params.runSessionKey,
        messageChannel: params.messageChannel,
        messageTo: params.resolvedDelivery.to,
        currentChannelId,
        agentAccountId: params.resolvedDelivery.accountId,
      }),
    },
  };
  return { modelResolve, currentChannelId };
}

/** Resolves cron model fallbacks, giving explicit payload fallbacks precedence over subagent/default policy. */
export function resolveCronFallbacksOverride(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  useSubagentFallbacks?: boolean;
  inheritDefaultFallbacksForAgentStringModel?: boolean;
  /** Stored provenance when the run uses the session's model selection. */
  sessionModelOverrideSource?: "auto" | "user";
}): string[] | undefined {
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : undefined;
  const hasCronPayloadModelOverride =
    typeof payload?.model === "string" && payload.model.trim().length > 0;
  if (payloadFallbacks !== undefined) {
    return payloadFallbacks;
  }
  if (params.sessionModelOverrideSource === "user" && !hasCronPayloadModelOverride) {
    // A user-selected session model is exact; automatic selections keep the configured chain.
    return resolveEffectiveModelFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
    });
  }
  if (params.useSubagentFallbacks === true && !hasCronPayloadModelOverride) {
    // A payload model override owns its full candidate chain; otherwise the
    // selected subagent can contribute its configured fallback policy.
    const subagentFallbacksOverride = resolveSubagentModelFallbacksOverride(
      params.cfg,
      params.agentId,
    );
    if (subagentFallbacksOverride !== undefined) {
      return subagentFallbacksOverride;
    }
  }
  if (!hasCronPayloadModelOverride && params.inheritDefaultFallbacksForAgentStringModel === true) {
    const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
    if (defaultFallbacks.length > 0) {
      return defaultFallbacks;
    }
  }
  return resolveEffectiveModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    hasSessionModelOverride: hasCronPayloadModelOverride,
    modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
  });
}

/** Builds the ordered model candidates used by cron preflight checks. */
export function resolveCronPreflightCandidates(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  provider: string;
  model: string;
  useSubagentFallbacks?: boolean;
  inheritDefaultFallbacksForAgentStringModel?: boolean;
  sessionModelOverrideSource?: "auto" | "user";
}): ModelCandidate[] {
  const fallbacksOverride = resolveCronFallbacksOverride(params);
  return resolveModelCandidateChain({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    fallbacksOverride,
  });
}

/** Selects the reachable candidate and retains only its remaining fallback chain. */
export async function resolveCronPreflight(
  params: Parameters<typeof resolveCronPreflightCandidates>[0],
) {
  const modelPreflightRuntime = await cronModelPreflightRuntimeLoader.load();
  const preflightCandidates = resolveCronPreflightCandidates(params);
  let firstUnavailableReason: string | undefined;
  for (const [index, candidate] of preflightCandidates.entries()) {
    const candidatePreflight = await modelPreflightRuntime.preflightCronModelProvider({
      cfg: params.cfg,
      provider: candidate.provider,
      model: candidate.model,
    });
    if (candidatePreflight.status === "unavailable") {
      firstUnavailableReason ??= candidatePreflight.reason;
      continue;
    }
    const modelFallbacksOverride =
      candidate.provider !== params.provider || candidate.model !== params.model
        ? preflightCandidates
            .slice(index + 1)
            .map((remaining) => `${remaining.provider}/${remaining.model}`)
        : undefined;
    if (modelFallbacksOverride && firstUnavailableReason !== undefined) {
      logWarn(
        `[cron:${params.job.id}] ${firstUnavailableReason}; continuing with fallback ${candidate.provider}/${candidate.model}.`,
      );
    }
    return {
      ok: true as const,
      provider: candidate.provider,
      model: candidate.model,
      modelFallbacksOverride,
      runtimePluginCandidates: preflightCandidates.slice(index),
    };
  }
  if (firstUnavailableReason !== undefined) {
    return { ok: false as const, reason: firstUnavailableReason };
  }
  return {
    ok: true as const,
    provider: params.provider,
    model: params.model,
    modelFallbacksOverride: undefined,
    runtimePluginCandidates: preflightCandidates,
  };
}
