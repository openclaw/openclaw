import {
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import {
  bindSessionMcpStoreOwner,
  inheritSessionMcpStoreOwner,
} from "../config/sessions/session-mcp-store-admission.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronAuthenticatedChannelRequester } from "../gateway/cron-creator-authority-grant.types.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { drainAgentRunTerminalWrites } from "../infra/agent-run-terminal-writes.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import { resolveScheduledSenderBit } from "./execution-context-registry.js";
import type { MintedScheduledExecution } from "./scheduled-occurrence.js";
import type { CronExecutionIdentityAdmission } from "./service/state.js";

/** Owns one cron tool admission and its private message grant through settlement. */
export function prepareCronRunAdmission(params: {
  admissionSource?: AdmittedRunContext["admissionSource"];
  assertSourceCurrent?: () => void;
  cfg: OpenClawConfig;
  agentId: string;
  runId: string;
  sessionId?: string;
  sessionKey: string;
  storeAdmission?: object;
  sourceReplySessionKey?: string;
  jobId: string;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
  channelRequester?: CronAuthenticatedChannelRequester;
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  executionIdentity?: CronExecutionIdentityAdmission;
  ingressBoundary?: "cron.isolated-agent" | "cron.session-agent" | "cron.script";
  onAdmitted?: (context: AdmittedRunContext) => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  resolveGatewayContext?: GatewayContextResolver;
  /** Minted from the run's admitted occurrence; bound to the admitted run and released with it. */
  scheduledExecution: MintedScheduledExecution;
}) {
  const { runId, scheduledToolPolicy } = params;
  const { result } = params.scheduledExecution;
  if (result.status !== "ready") {
    // A scheduled run starts only with its admitted context; the run record and the
    // job's failure notice carry this refusal.
    const cause = result.status === "fail" ? result.error : `its conversation is ${result.reason}`;
    throw new Error(
      `This automation's access could not be admitted (${cause}), so the run did not start. Recreate the automation from a chat that still has access.`,
    );
  }
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const resolveGatewayContext =
    params.resolveGatewayContext ?? getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  let assertAdmitted: SessionSourceAssertion | undefined;
  const readAdmittedSource = () => {
    if (!assertAdmitted) {
      throw new Error("cron message delivery requires its admitted run");
    }
    return assertAdmitted;
  };
  const basePreparedRunAdmission = prepareAgentRunAdmission({
    operationalRunInstance,
    admissionSource: params.admissionSource,
    assertSourceCurrent: params.assertSourceCurrent,
    operatorAuthority: params.operatorAuthority,
    cfg: params.cfg,
    facts: {
      runId,
      agentId: params.agentId,
      ingress: params.executionIdentity?.ingress ?? {
        kind: "schedule",
        boundary: params.ingressBoundary ?? "cron.isolated-agent",
        state: "present",
      },
      ...(params.executionIdentity?.invoker ? { invoker: params.executionIdentity.invoker } : {}),
    },
    onAdmitted: (admitted) => {
      bindGatewayContextResolver(admitted, resolveGatewayContext);
      assertAdmitted = resolveAdmittedRunActiveAssertion(admitted);
      params.onAdmitted?.(admitted);
      params.scheduledExecution.bind(admitted.operationalRunInstance, () => readAdmittedSource()());
    },
  });
  const preparedRunAdmission = params.executionIdentity?.onPostAdmission
    ? withPostAdmissionExecutionOwnerBinding(
        basePreparedRunAdmission,
        params.executionIdentity.onPostAdmission,
      )
    : basePreparedRunAdmission;
  const scheduledMessage =
    scheduledToolPolicy && isRuntimeToolAllowed("message", params.toolsAllow);
  const deliveryAttemptFence = params.deliveryAttemptFence;
  const assertAdmittedRun = Object.assign(() => readAdmittedSource()(), {
    prepareSessionSource: () => prepareSessionSourceAuthority(readAdmittedSource()),
  });
  const assertRunCurrent = composeSessionSourceAssertion([
    assertAdmittedRun,
    deliveryAttemptFence?.standingGrantAuthority?.assertCurrent ??
      deliveryAttemptFence?.assertCurrent,
  ]);
  // This opaque token remains unusable until this exact operational instance
  // is admitted by the live occurrence. Scheduled runners redeem the same host grant.
  const messageActionTurnCapability = deliveryAttemptFence
    ? mintMessageActionTurnCapability({
        agentId: params.agentId,
        runId,
        sessionKey: params.sessionKey,
        sourceReplySessionKey: params.sourceReplySessionKey,
        sessionId: params.sessionId,
        requesterAccountId:
          scheduledMessage && scheduledToolPolicy?.mode === "account"
            ? scheduledToolPolicy.ownerAccountId
            : undefined,
        deliveryAttempt: {
          beforeAttempt: () => deliveryAttemptFence.beforeAttempt(),
          assertCurrent: composeSessionSourceAssertion([
            assertAdmittedRun,
            deliveryAttemptFence.assertCurrent,
          ]),
        },
        ...(scheduledMessage && scheduledToolPolicy
          ? {
              scheduled: {
                policy: scheduledToolPolicy,
                assertCurrent: assertRunCurrent,
                assertSourceCurrent: assertRunCurrent,
                ...(params.channelRequester ? { channelRequester: params.channelRequester } : {}),
              },
            }
          : {}),
        expiresWithRun: true,
      })
    : undefined;
  inheritSessionMcpStoreOwner(params.storeAdmission, operationalRunInstance);
  const close = () => {
    bindSessionMcpStoreOwner(operationalRunInstance, undefined);
    params.scheduledExecution.release();
    revokeMessageActionTurnCapability(messageActionTurnCapability);
    preparedRunAdmission.close();
  };
  return {
    preparedRunAdmission,
    standingGrantAuthority: deliveryAttemptFence?.standingGrantAuthority
      ? {
          ...deliveryAttemptFence.standingGrantAuthority,
          assertCurrent: assertRunCurrent,
        }
      : undefined,
    messageActionTurnCapability,
    /** The minted execution context once the run is admitted. */
    readScheduledExecution: () => params.scheduledExecution.current(),
    /** The run's one sender bit, shared by every runtime candidate. */
    scheduledSender: resolveScheduledSenderBit(params.scheduledExecution.result),
    close,
    finish: async () => {
      await drainAgentRunTerminalWrites(preparedRunAdmission.operationalRunInstance).finally(close);
    },
  };
}
