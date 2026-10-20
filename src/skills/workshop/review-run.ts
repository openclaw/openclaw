import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { createAgentToolExecutionBudget } from "../../agents/agent-tool-source-execution-guard.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { onGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { getSkillWorkshopReviewLane } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import {
  getActiveSessionRunCount,
  isSessionRunActive,
} from "../../sessions/session-controller.queries.js";

/**
 * The background Workshop review run: the completed runtime on a locked model, crediting
 * changes to the reviewed session.
 */
export async function runSkillWorkshopReview(
  params: RunEmbeddedAgentParams & {
    agentId: string;
    config: OpenClawConfig;
    preparedRunAdmission: NonNullable<RunEmbeddedAgentParams["preparedRunAdmission"]>;
    skillWorkshopReviewOf: string;
  },
) {
  const foreground = new AbortController();
  const limits = new AbortController();
  const timeoutMs = Math.min(params.timeoutMs, 120_000);
  const deadline = setTimeout(
    () => limits.abort(new DOMException("Skill review deadline exceeded", "TimeoutError")),
    timeoutMs,
  );
  deadline.unref();
  const yieldToForeground = () => {
    const ownRun = isSessionRunActive(params.sessionId) ? 1 : 0;
    if (getActiveSessionRunCount() > ownRun) {
      foreground.abort(new DOMException("Skill review yielded to foreground work", "AbortError"));
    }
  };
  const unsubscribe = onGatewayWorkMetricsChanged(yieldToForeground);
  const abortSignal = AbortSignal.any([
    getGatewayRestartDrainSignal(),
    foreground.signal,
    limits.signal,
    ...(params.abortSignal ? [params.abortSignal] : []),
  ]);
  const budget = createAgentToolExecutionBudget({
    maxToolCalls: 8,
    signal: abortSignal,
    abort: (reason) => limits.abort(reason),
  });
  const runtime = params.agentHarnessId ?? "openclaw";
  // Background runs stay out of the Control UI and never project into a user session.
  registerAgentRunContext(params.runId, {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    isControlUiVisible: false,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  try {
    yieldToForeground();
    abortSignal.throwIfAborted();
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    const result = await budget.run(() =>
      runEmbeddedAgent({
        ...params,
        abortSignal,
        lane: getSkillWorkshopReviewLane(),
        agentHarnessId: runtime,
        agentHarnessRuntimeOverride: runtime,
        // Review is best-effort work: never spend interactive capacity on retries.
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
        retryTransientErrors: false,
        allowAuthProfileFallback: false,
        authProfileFailurePolicy: "local_transient",
        requestedRouteResolution: "resolved",
        sessionPersistence: "detached",
        promptCacheKey: undefined,
        sourceReplyDeliveryMode: undefined,
        toolsAllow: ["skill_workshop"],
        toolExecutionAllow: ["skill_workshop"],
        codeModeOverride: false,
        disableToolSearch: true,
        promptMode: "minimal",
        bootstrapContextMode: "lightweight",
        skillsSnapshot: undefined,
        extraSystemPrompt: undefined,
        clientTools: undefined,
        conversationRecall: undefined,
        gitCoauthorPrompt: undefined,
        forceMessageTool: false,
        forceHeartbeatTool: false,
        contextTokenBudget: 16_384,
        // Native runtimes do not accept provider transport overrides. Their review
        // is bounded by the shared deadline and final tool-execution budget instead.
        streamParams: runtime === "openclaw" ? { maxTokens: 2_048 } : undefined,
        thinkLevel: "low",
        timeoutMs,
        disableTrajectory: true,
        silentExpected: true,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        cleanupBundleMcpOnRunEnd: true,
        verboseLevel: "off",
      }),
    );
    abortSignal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(deadline);
    unsubscribe();
    params.preparedRunAdmission.close();
    clearAgentRunContext(params.runId);
    cleanupSessionResources(params.sessionId);
  }
}
