import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import type { ScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { isRuntimeToolAllowed } from "../../agents/tool-policy-match.js";
import { withPostAdmissionExecutionOwnerBinding } from "../../audit/execution-owner-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronAuthenticatedChannelRequester } from "../../gateway/cron-creator-authority-grant.types.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { captureCronJobMessageActionAuthority } from "../active-jobs.js";
import type { CronRuntimeAuthority } from "../runtime-authority.js";
import type { CronExecutionIdentityAdmission } from "../service/state.js";

export function assertCronRuntimeAuthorityCandidate(params: {
  authority?: CronRuntimeAuthority;
  candidateRuntime: string;
  cliExecution: boolean;
}): void {
  const authority = params.authority;
  if (!authority) {
    return;
  }
  if (params.candidateRuntime !== authority.runtimeId || params.cliExecution) {
    throw new AgentHarnessPreflightError(
      `This automation carries ${authority.namespace} authority captured for the ${authority.runtimeId} runtime, but the selected execution runtime is ${params.candidateRuntime}. Restore that runtime and auth profile, or explicitly replace the automation's toolsAllow cap from an authenticated creator turn.`,
    );
  }
}

/** Owns one prompt admission and its private message grant through settlement. */
export function prepareCronPromptRunAdmission(params: {
  cfg: OpenClawConfig;
  agentId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  jobId: string;
  channelRequester?: CronAuthenticatedChannelRequester;
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  executionIdentity?: CronExecutionIdentityAdmission;
}) {
  const { runId, scheduledToolPolicy } = params;
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const basePreparedRunAdmission = prepareAgentRunAdmission({
    operationalRunInstance,
    cfg: params.cfg,
    facts: {
      runId,
      agentId: params.agentId,
      ingress: params.executionIdentity?.ingress ?? {
        kind: "schedule",
        boundary: "cron.isolated-agent",
        state: "present",
      },
      ...(params.executionIdentity?.invoker ? { invoker: params.executionIdentity.invoker } : {}),
    },
    onAdmitted: (admitted) => bindGatewayContextResolver(admitted, resolveGatewayContext),
  });
  const preparedRunAdmission = params.executionIdentity?.onPostAdmission
    ? withPostAdmissionExecutionOwnerBinding(
        basePreparedRunAdmission,
        params.executionIdentity.onPostAdmission,
      )
    : basePreparedRunAdmission;
  const scheduledMessageAuthority =
    scheduledToolPolicy && isRuntimeToolAllowed("message", params.toolsAllow)
      ? captureCronJobMessageActionAuthority({ jobId: params.jobId, operationalRunInstance })
      : undefined;
  // This opaque token remains unusable until this exact operational instance
  // is admitted by the live occurrence. Both runners redeem the same host grant.
  const messageActionTurnCapability =
    scheduledMessageAuthority && scheduledToolPolicy
      ? mintMessageActionTurnCapability({
          agentId: params.agentId,
          runId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          requesterAccountId:
            scheduledToolPolicy.mode === "account" ? scheduledToolPolicy.ownerAccountId : undefined,
          scheduled: {
            policy: scheduledToolPolicy,
            assertCurrent: scheduledMessageAuthority,
            ...(params.channelRequester ? { channelRequester: params.channelRequester } : {}),
          },
          expiresWithRun: true,
        })
      : undefined;
  return {
    preparedRunAdmission,
    messageActionTurnCapability,
    close: () => {
      revokeMessageActionTurnCapability(messageActionTurnCapability);
      preparedRunAdmission.close();
    },
  };
}
