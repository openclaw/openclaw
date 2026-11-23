import { randomUUID } from "node:crypto";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { bindUserTurnInputActor } from "../../config/sessions/session-input-actor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "../../gateway/session-system-turn-authority.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { getInProcessGatewayRequestContext } from "../../plugins/runtime/gateway-request-scope.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.session-reader.js";
import { settleUserTurnPendingInput } from "../../sessions/user-turn-transcript-processing.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { prepareCommandOwnerAuthority } from "../command-auth.js";
import { bindCommandOwnerAuthority, getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import type { FollowupRun } from "./queue/types.js";

/** Acquire original input custody before maintenance or a provider can consume it. */
export async function prepareReplySourceAdmission(params: {
  operation: ReplyOperation;
  followupRun: FollowupRun;
  recorder?: UserTurnTranscriptRecorder;
  runId?: string;
}): Promise<(() => Promise<void>) | undefined> {
  const { operation, followupRun, recorder } = params;
  if (!recorder) {
    return undefined;
  }
  // Session events re-admit stale policy before their owner claims the durable source.
  // Early staging would bind that stable source to an attempt that never ran.
  if (followupRun.run.internalEventExecution) {
    return undefined;
  }
  const assertCurrent = () => {
    operation.abortSignal.throwIfAborted();
    if (operation.lifecycleGeneration) {
      assertAgentRunLifecycleGenerationCurrent(operation.lifecycleGeneration);
    }
    assertSessionControllerOperation(operation);
  };
  assertCurrent();
  await recorder.resolveMessage();
  assertCurrent();
  const ownsCustody = !recorder.getPendingInputMessage?.() && !recorder.hasPersisted();
  let admissionFailure: unknown;
  const release = ownsCustody
    ? () =>
        settleUserTurnPendingInput(
          recorder,
          operation.abortSignal,
          admissionFailure,
          false,
          "cancelled",
          operation.turnKind === "queued_followup",
        )
    : undefined;
  try {
    if (ownsCustody && getReplyOperationSessionTarget(operation)) {
      // First-turn staging precedes dispatch; use this operation's initialized
      // physical actor instead of the recorder's pre-initialization Gateway locator.
      bindUserTurnInputActor(recorder, {
        phase: "acceptInput",
        acquire: async () => {
          assertCurrent();
          const actor = await acquireReplyOperationSessionActor(operation);
          assertCurrent();
          const target = getReplyOperationSessionTarget(operation);
          if (!actor || !target) {
            throw new Error("Reply operation lost its session actor admission");
          }
          return { actor, target };
        },
      });
    }
    await recorder.stageApproved?.({ runId: params.runId ?? randomUUID(), assertCurrent });
    assertCurrent();
    return release;
  } catch (error) {
    admissionFailure = error;
    await release?.();
    throw error;
  }
}

/** Required preflight can invoke models and tools before the reply runner exists. */
export async function admitReplyMaintenance(
  turn: {
    readonly runId: string;
    queued: FollowupRun;
    operation: ReplyOperation;
  },
  sessionKey: string | undefined,
  assertCurrent: () => void,
): Promise<void> {
  const execution = turn.queued.run.internalEventExecution;
  await execution?.beforeScheduledStart?.(turn.runId);
  assertCurrent();
  // Maintenance owns the occurrence before effects, preventing pre-execution policy replay.
  execution?.onStarted(turn.runId);
  const automation = turn.queued.run.scheduledAutomation;
  if (automation && sessionKey) {
    automation.onExecutionStarted?.({
      runId: turn.runId,
      sessionId: turn.operation.sessionId,
      sessionKey,
      provider: turn.queued.run.provider,
      model: turn.queued.run.model,
    });
    automation.onExecutionPhase?.({ jobId: automation.job.id, phase: "context_engine" });
  }
}

/** Acquire caller-owned custody before publishing a queued execution. */
export async function enqueueReplySourceAdmission(params: {
  options?: Pick<InternalGetReplyOptions, "turnAdoptionLifecycle" | "userTurnTranscriptRecorder">;
  input: SessionControllerInput;
  followupRun: FollowupRun;
  runId: string;
  assertCurrent: () => void;
  enqueue: () => boolean;
}): Promise<boolean> {
  const { options, input, runId } = params;
  const recorder =
    options?.turnAdoptionLifecycle?.admission === "cancel-only"
      ? options.userTurnTranscriptRecorder
      : undefined;
  const assertCurrent = () => {
    input.abortSignal.throwIfAborted();
    params.assertCurrent();
    input.sourceAdapter?.authority?.assertCurrent();
  };
  let staged = false;
  if (recorder && !recorder.getPendingInputMessage?.() && !recorder.hasPersisted()) {
    // Gateway recorders own cleanup, but slash commands skip initial staging.
    // Execution policy still resolves when the queued turn is admitted.
    const accepted = await recorder.stageApproved?.({ runId, assertCurrent });
    assertCurrent();
    if (recorder.isPendingInputConsumed?.()) {
      completeFollowupRunLifecycle(params.followupRun, "consumed");
      return false;
    }
    if (accepted === false) {
      throw new Error("Followup input could not acquire durable custody");
    }
    staged = accepted === true;
  }
  const enqueued = params.enqueue();
  if (!enqueued && staged) {
    // Terminal overflow already records its own cause. Retryable capacity pressure
    // leaves the accepted row and its live owner with the mailbox.
    if (recorder?.isPendingInputConsumed?.()) {
      recorder.releasePendingInput?.();
    }
    await recorder?.waitForPendingInputSettlement?.();
  }
  return enqueued;
}

/** Only unattributed host inputs may fall back to the current session principal. */
export async function prepareReplySystemPrincipalAuthority(params: {
  followupRun: FollowupRun;
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
  resolveGatewayContext?: GatewayContextResolver;
  assertCurrent: () => void;
}) {
  const { followupRun, sessionKey } = params;
  if (!followupRun.sessionPrincipalTurn || followupRun.operatorAuthority) {
    return undefined;
  }
  const context = getInProcessGatewayRequestContext(params.resolveGatewayContext);
  if (!context || !sessionKey) {
    return undefined;
  }
  const principal = await prepareSessionSystemTurnAuthority({
    context,
    agentId: followupRun.run.agentId,
    sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
    assertCurrent: params.assertCurrent,
  });
  if (principal) {
    const { authority } = principal;
    const run = followupRun.run;
    run.senderIsOwner = authority.scopes.includes("operator.admin");
    run.traceAuthorized = run.senderIsOwner;
    run.senderId = undefined;
    run.senderName = undefined;
    bindCommandOwnerAuthority(run, {
      operatorAuthority: authority,
      isCurrent: () => {
        authority.assertCurrent();
        return true;
      },
    });
  }
  return principal;
}

/** Admit a queued command-owner source once, retaining only the execution's lifetime afterward. */
export async function prepareReplyCommandOwnerAuthority(params: {
  run: FollowupRun["run"];
  config: OpenClawConfig;
  operation: ReplyOperation;
  hasOperatorAuthority: boolean;
  assertCurrent: () => void;
}): Promise<void> {
  const { run, operation } = params;
  // Command-owner policy belongs to the host, not the model's scoped execution config.
  const config = getRuntimeConfigSnapshot() ?? params.config;
  const origin = run.requesterOrigin;
  const retainedOwner = getCommandOwnerAuthority(run);
  const ownerReference = retainedOwner?.recoveryReference;
  const channelPrincipal =
    retainedOwner?.channelPrincipal ??
    (!run.internalEventExecution &&
    !run.sessionEventOrigin &&
    origin?.messageProvider &&
    !origin.operatorProfileId &&
    origin.messageProvider !== INTERNAL_MESSAGE_CHANNEL &&
    origin.senderId
      ? {
          channelId: origin.messageProvider,
          accountId: normalizeAccountId(origin.accountId),
          senderId: origin.senderId,
        }
      : undefined);
  const nativeOwner =
    channelPrincipal && ownerReference?.version !== 1
      ? {
          channel: channelPrincipal.channelId,
          accountId: channelPrincipal.accountId,
          senderId: channelPrincipal.senderId,
          senderE164:
            origin?.messageProvider === channelPrincipal.channelId &&
            normalizeAccountId(origin.accountId) === channelPrincipal.accountId &&
            origin.senderId === channelPrincipal.senderId
              ? (origin.senderE164 ?? undefined)
              : undefined,
        }
      : undefined;
  if (
    ownerReference ||
    nativeOwner ||
    (origin?.messageProvider &&
      !origin.operatorProfileId &&
      origin.messageProvider !== INTERNAL_MESSAGE_CHANNEL &&
      !run.internalEventExecution &&
      !run.sessionEventOrigin)
  ) {
    const owner = await prepareCommandOwnerAuthority(
      config,
      nativeOwner ??
        ownerReference ?? {
          channel: origin?.messageProvider ?? undefined,
          accountId: origin?.accountId ?? undefined,
          senderId: origin?.senderId ?? undefined,
          senderE164: origin?.senderE164 ?? undefined,
        },
    );
    params.assertCurrent();
    const senderIsOwner = owner.isCurrent(config);
    run.senderIsOwner = senderIsOwner;
    run.traceAuthorized = senderIsOwner;
    bindCommandOwnerAuthority(run, {
      recoveryReference: owner.recoveryReference,
      channelPrincipal,
      isCurrent: () => senderIsOwner && !operation.abortSignal.aborted && !operation.result,
      // A successor re-admits these native source facts, not this operation's lifetime.
      successor: {
        recoveryReference: owner.recoveryReference,
        channelPrincipal,
        isCurrent: () => senderIsOwner,
      },
    });
  } else if (!params.hasOperatorAuthority && retainedOwner) {
    // A profile-only or legacy owner has no authenticated source for another owner turn.
    run.senderIsOwner = false;
    run.traceAuthorized = false;
    bindCommandOwnerAuthority(run, { isCurrent: () => false });
  }
}
