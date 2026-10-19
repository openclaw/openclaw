import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { onGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import {
  getActiveSessionRunCount,
  isSessionRunActive,
} from "../../sessions/session-controller.queries.js";

const reviews = createBackgroundWorkOwner({ owner: "core:skill-workshop", maxConcurrent: 1 });

/**
 * The background Workshop review run: the openclaw harness on a locked model, crediting
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
    ...(params.abortSignal ? [params.abortSignal] : []),
  ]);
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
    const result = await runEmbeddedAgent({
      ...params,
      abortSignal,
      lane: reviews.lane,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
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
      streamParams: { maxTokens: 2_048 },
      thinkLevel: "low",
      timeoutMs: Math.min(params.timeoutMs, 120_000),
      disableTrajectory: true,
      silentExpected: true,
      allowEmptyAssistantReplyAsSilent: true,
      terminalReplyExpectation: "optional",
      cleanupBundleMcpOnRunEnd: true,
      verboseLevel: "off",
    });
    foreground.signal.throwIfAborted();
    return result;
  } finally {
    unsubscribe();
    params.preparedRunAdmission.close();
    clearAgentRunContext(params.runId);
  }
}
