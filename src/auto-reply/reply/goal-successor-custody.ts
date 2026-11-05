import { readToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { persistSessionGoalSuccessor } from "../../config/sessions/goal-successor.js";
import type { SessionGoalSuccessor } from "../../config/sessions/goal-successor.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { captureQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.js";
import { getInProcessGatewayRequestContext } from "../../plugins/runtime/gateway-request-scope.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import type { FollowupRun } from "./queue/types.js";

/** Called by the admitted turn/yield/queue owner before it releases predecessor custody. */
export async function persistGoalSuccessorCustody(params: {
  base: FollowupRun;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  sourceRunId: string;
  phase: SessionGoalSuccessor["phase"];
  childRunIds?: string[];
  assertCurrent: () => void;
}): Promise<boolean> {
  const { base, entry } = params;
  if (!entry.goal || entry.goal.status !== "active" || base.run.scheduledAutomation) {
    return false;
  }
  params.assertCurrent();
  base.operatorAuthority?.assertCurrent();
  // Source-bound capabilities without a durable owner must not become a principal turn.
  const refusal =
    base.channelAdmissionEvidence ||
    base.run.toolBindings ||
    base.run.runtimePluginToolGrant ||
    base.run.conversationToolPolicy ||
    base.run.scheduledToolPolicy ||
    base.run.trustedInternalHandoff ||
    base.operatorAuthority?.invocation ||
    base.run.sourceReplyDeliveryMode === "message_tool_only"
      ? "Goal source has process-bound capabilities; send a fresh authorized message to continue."
      : undefined;
  const source = captureQueuedOperatorRecoverySource(base.operatorAuthority) ?? {
    kind: "unavailable" as const,
  };
  const toolsAllow = base.disableTools
    ? [[]]
    : base.toolsAllow
      ? (readToolAllowlistIntersection(base.toolsAllow) ?? [base.toolsAllow]).map((allow) =>
          allow.slice(),
        )
      : undefined;
  const deliver =
    base.run.internalEventExecution?.deliver !== false &&
    base.run.sessionEventOrigin?.deliver !== false &&
    base.queuedFollowupReplyDisposition?.kind !== "drop";
  const placement =
    await getInProcessGatewayRequestContext()?.workerSessionPlacementService?.prepareSessionPlacement?.(
      entry.sessionId,
    );
  let requiresWorker =
    base.goalContinuation?.workerGoal === true ||
    Boolean(base.run.config?.cloudWorkers?.requiredProfile);
  try {
    await placement?.prepareRead();
    const current = placement?.current();
    if (current) {
      if (
        current.sessionId !== entry.sessionId ||
        current.sessionKey !== params.sessionKey ||
        current.agentId !== base.run.agentId
      ) {
        throw new Error("Goal placement changed before custody publication");
      }
      requiresWorker ||= current.state !== "local";
    }
  } finally {
    placement?.release();
  }
  params.assertCurrent();
  base.operatorAuthority?.assertCurrent();
  const successor: SessionGoalSuccessor = {
    version: 1,
    id: [entry.sessionId, entry.goal.id, params.sourceRunId, params.phase].join(":"),
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    goalId: entry.goal.id,
    sourceRunId: params.sourceRunId,
    phase: params.phase,
    childRunIds: params.childRunIds,
    source,
    refusal,
    toolsAllow,
    settings: { permissionMode: base.run.permissionMode, toolOverrides: base.run.toolOverrides },
    deliver,
    deliveryContext: base.originatingChannel
      ? {
          channel: base.originatingChannel,
          to: base.originatingTo,
          accountId: base.originatingAccountId,
          threadId: base.originatingThreadId,
        }
      : deliveryContextFromSession(entry),
    ownerContinuation: base.run.senderIsOwner === true,
    requiresWorker,
  };
  return persistSessionGoalSuccessor(
    { agentId: base.run.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    successor,
    () => {
      params.assertCurrent();
      base.operatorAuthority?.assertCurrent();
    },
  );
}
