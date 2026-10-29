import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Runtime lookups the caller supplies, so capture and run share one decision. */
export type CronCandidateExecutionDeps = {
  isCliProvider: (provider: string, cfg: OpenClawConfig) => boolean;
  resolveEffectiveAgentRuntime: (params: {
    cfg: OpenClawConfig;
    provider: string;
    modelId: string;
    agentId: string;
    sessionKey?: string;
    sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
  }) => string;
};

/** The runtime and execution route one candidate runs on. */
export type CronCandidateExecution = {
  sessionRuntimeOverride: string | undefined;
  executionProvider: string;
  cliExecution: boolean;
  runtime: string;
};

/**
 * Resolves where a candidate runs: a compatible session runtime override first, then the
 * config's runtime policy. Inference capture and every scheduled run call this, so a job's
 * captured runtime is the one its run selects for the same inputs.
 */
export function resolveCronCandidateExecution(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    provider: string;
    model: string;
    sessionRuntimeOverride: string | undefined;
    sessionKey?: string;
    sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
    /** An explicitly selected profile, which can itself name a CLI backend's login. */
    authProfileId?: string;
  },
  deps: CronCandidateExecutionDeps,
): CronCandidateExecution {
  const { cfg, provider, model, sessionRuntimeOverride } = params;
  // An override names its own backend; without one the config policy may still pick a CLI.
  const executionProvider = sessionRuntimeOverride
    ? deps.isCliProvider(sessionRuntimeOverride, cfg)
      ? sessionRuntimeOverride
      : provider
    : (resolveCliRuntimeExecutionProvider({
        provider,
        cfg,
        agentId: params.agentId,
        modelId: model,
        authProfileId: params.authProfileId,
      }) ?? provider);
  const runtime =
    sessionRuntimeOverride ??
    deps.resolveEffectiveAgentRuntime({
      cfg,
      provider,
      modelId: model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
    });
  return {
    sessionRuntimeOverride,
    executionProvider,
    cliExecution: deps.isCliProvider(executionProvider, cfg),
    runtime,
  };
}
