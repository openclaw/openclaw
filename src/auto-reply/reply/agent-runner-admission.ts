import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { resolveCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import { captureAgentRunLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
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
  const assertSourceCurrent = composeSessionSourceAssertion([
    params.followupRun.run.senderIsOwner === true
      ? captureCommandOwnerAssertion(params.followupRun.run)
      : undefined,
    params.followupRun.run.internalEventExecution?.assertCurrent,
    automation?.assertCurrent,
  ]);
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
      sourceContext: params.followupRun.run,
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
  let releaseCronSource: (() => void) | undefined;
  const closeAdmission = () => {
    try {
      (cronAdmission?.close ?? preparedRunAdmission.close)();
    } finally {
      releaseCronSource?.();
    }
  };
  try {
    if (cronAdmission && automation) {
      releaseCronSource = registerCronRunExecSource(runId, {
        agentId: params.followupRun.run.agentId,
        jobId: automation.job.id,
        jobName: automation.job.name,
        jobConfigRevision: resolveCronJobConfigRevision(automation.job),
        standingGrantAuthority: cronAdmission.standingGrantAuthority,
      });
    }
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
            closeAdmission,
          );
        }
      },
    };
  } catch (error) {
    closeAdmission();
    throw error;
  }
}

/** Retains the scheduled run's registry claim through terminal settlement. */
export function prepareReplyTurnRunSource(params: AgentTurnParams, runId: string) {
  const automation = params.followupRun.run.scheduledAutomation;
  let runContextOwnerToken: string | undefined;
  return {
    claim() {
      automation?.assertCurrent();
      if (automation) {
        runContextOwnerToken = claimAgentRunContext(
          runId,
          {
            sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
            sessionId: params.followupRun.run.sessionId,
            agentId: params.followupRun.run.agentId,
            lifecycleGeneration: captureAgentRunLifecycleGeneration(runId),
            cronRunsByJobId: new Map([
              [
                automation.job.id,
                {
                  pacingEnabled: automation.job.pacing !== undefined,
                  assertCurrent: () => {
                    automation.assertCurrent();
                    if (
                      !params.replyOperation ||
                      params.replyOperation.result ||
                      params.replyOperation.abortSignal.aborted
                    ) {
                      throw new Error("Automation reply owner has closed");
                    }
                  },
                },
              ],
            ]),
          },
          { trackOwner: true, ownsContext: true },
        );
        if (!runContextOwnerToken) {
          throw new Error("The scheduled run context already has an exclusive owner");
        }
      }
    },
    close() {
      releaseAgentRunContext(runId, runContextOwnerToken);
    },
  };
}
