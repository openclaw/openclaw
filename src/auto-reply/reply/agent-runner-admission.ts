import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { resolveCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { captureCommandOwnerAssertion } from "../command-owner-authority.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { resolveReplyScheduledToolPolicy } from "./agent-runner-run-params.js";
import { resolveQueuedReplyRuntimeConfig } from "./agent-runner-utils.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";

/** Owns reply admission and closes its delivery grant after deferred and terminal writes settle. */
export function prepareReplyTurnExecution(params: AgentTurnParams, runId: string) {
  const admittedRunContext: { current?: AdmittedRunContext } = {};
  const gatewayContextResolver =
    readChannelContextGatewayContextResolver(params.sessionCtx) ??
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const automation = params.followupRun.run.scheduledAutomation;
  const assertEventCurrent = params.followupRun.run.internalEventExecution?.assertCurrent;
  const assertCommandCurrent =
    params.followupRun.run.senderIsOwner === true
      ? captureCommandOwnerAssertion(params.followupRun.run)
      : undefined;
  const assertSourceCurrent =
    assertEventCurrent || assertCommandCurrent
      ? () => {
          assertEventCurrent?.();
          assertCommandCurrent?.();
        }
      : undefined;
  const sessionKey = params.sessionKey ?? params.followupRun.run.sessionKey;
  if (automation && !sessionKey) {
    throw new Error("A scheduled session turn requires its admitted session key");
  }
  const onAdmitted = (context: AdmittedRunContext) => {
    bindGatewayContextResolver(context, gatewayContextResolver);
    admittedRunContext.current = context;
    params.followupRun.run.skillLibraryAuthoring?.bind(context);
  };
  const cronAdmission =
    automation && sessionKey
      ? prepareCronRunAdmission({
          admissionSource: automation.admissionSource,
          assertSourceCurrent,
          cfg: resolveQueuedReplyRuntimeConfig(params.followupRun.run.config),
          agentId: params.followupRun.run.agentId,
          runId,
          sessionId: params.followupRun.run.sessionId,
          sessionKey,
          jobId: automation.job.id,
          deliveryAttemptFence: automation.deliveryAttemptFence ?? null,
          channelRequester: resolveCronAuthenticatedChannelRequester(automation.job),
          toolsAllow:
            automation.job.payload.kind === "agentTurn"
              ? automation.job.payload.toolsAllow
              : undefined,
          scheduledToolPolicy: resolveReplyScheduledToolPolicy(params.followupRun.run),
          executionIdentity: automation.executionIdentity,
          ingressBoundary: "cron.session-agent",
          resolveGatewayContext: gatewayContextResolver,
          onAdmitted,
        })
      : undefined;
  const preparedRunAdmission =
    cronAdmission?.preparedRunAdmission ??
    prepareChannelRunAdmission({
      cfg: resolveQueuedReplyRuntimeConfig(params.followupRun.run.config),
      runId,
      agentId: params.followupRun.run.agentId,
      ingressKind: "channel",
      boundary: "auto-reply.agent-runner",
      operatorAuthority: params.followupRun.operatorAuthority,
      evidence: params.followupRun.channelAdmissionEvidence,
      gatewayLocalUserIngress: params.followupRun.gatewayLocalUserIngress,
      assertSourceCurrent,
      onAdmitted,
    });
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId,
    agentId: params.followupRun.run.agentId,
    sessionId: params.followupRun.run.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.followupRun.run.sessionFile,
    abortSignal: resolveFollowupAbortSignal({
      abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
      operatorAuthority: params.followupRun.operatorAuthority,
    }),
  });
  return {
    preparedRunAdmission,
    admittedRunContext,
    deferredLifecycle,
    scheduledMessageActionTurnCapability: cronAdmission?.messageActionTurnCapability,
    async close() {
      try {
        await deferredLifecycle.complete();
      } finally {
        await drainAgentRunTerminalWrites(preparedRunAdmission.operationalRunInstance).finally(
          cronAdmission?.close ?? preparedRunAdmission.close,
        );
      }
    },
  };
}
