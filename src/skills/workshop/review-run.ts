import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";

const reviews = createBackgroundWorkOwner({ owner: "core:skill-workshop", maxConcurrent: 1 });

/**
 * A background review can look things up but changes nothing outside learned skills: it runs
 * unattended on conversation content, so it must never re-run the task or touch other files.
 */
const SKILL_WORKSHOP_REVIEW_TOOLS = [
  "skill_workshop",
  "read",
  "ls",
  "view_image",
  "web_search",
  "web_fetch",
  "sessions_history",
  "sessions_search",
  "memory_search",
  "memory_get",
] as const;

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
  const restartSignal = getGatewayRestartDrainSignal();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([restartSignal, params.abortSignal])
    : restartSignal;
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
    abortSignal.throwIfAborted();
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    return await runEmbeddedAgent({
      ...params,
      abortSignal,
      lane: reviews.lane,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      // Review prompts and cloned prefixes are sized for this exact model.
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      requestedRouteResolution: "resolved",
      sessionPersistence: "detached",
      toolExecutionAllow: SKILL_WORKSHOP_REVIEW_TOOLS,
      disableTrajectory: true,
      silentExpected: true,
      allowEmptyAssistantReplyAsSilent: true,
      terminalReplyExpectation: "optional",
      cleanupBundleMcpOnRunEnd: true,
      verboseLevel: "off",
    });
  } finally {
    params.preparedRunAdmission.close();
    clearAgentRunContext(params.runId);
  }
}
