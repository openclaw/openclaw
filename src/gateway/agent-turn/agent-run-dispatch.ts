import { normalizeAgentRunTimeoutPhase } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { withAgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";
import {
  buildAgentRunTerminalOutcome,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import type { PreparedAgentCommandRuntimeContext } from "../../agents/command/prepare.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { runWithCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import type {
  FollowupCompletionOwner,
  FollowupReply,
} from "../../agents/subagents/completion/session-followup-completion.types.js";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../../channels/turn/agent-run-terminal-outcome.js";
import { agentCommandFromGatewayIngress } from "../../commands/agent.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import type { createAssistantCommentaryMediaCustody } from "../server-methods/chat-send-commentary-media.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import type { DedupeEntry } from "../server-shared.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { captureAgentJobSession } from "./agent-job.js";
import { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import { readAgentRunDispatchExecutionIdentity } from "./agent-run-dispatch-execution-identity.js";
import {
  isGatewayAgentAbortRejection,
  projectRejectedGatewayStatus,
  RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION,
  resolveGatewayAgentAbortStopReason,
  resolveResolvedAgentTimeoutStopReason,
} from "./agent-run-dispatch-outcome.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

export function dispatchAgentRunFromGateway(params: {
  assertCurrent?: () => void;
  assertSettlementCurrent?: () => void;
  followupCompletion?: FollowupCompletionOwner;
  admittedRunEntry: ChatAbortControllerEntry | undefined;
  ingressOpts: Parameters<typeof agentCommandFromGatewayIngress>[0];
  loadCommentaryMedia?: () => Promise<ReturnType<typeof createAssistantCommentaryMediaCustody>>;
  runId: string;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  cleanupAbortController: () => void | Promise<void>;
  io: AgentTurnIo;
  context: AgentTurnContext;
  canonicalSkillWorkspaceDir?: string;
  restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  commandRuntimeContext?: PreparedAgentCommandRuntimeContext;
  /** Privacy classification carried from the resolved session entry. */
  isIncognito?: boolean;
  onSettled?: (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }) => Promise<boolean> | boolean;
}) {
  const diagnostics = createAgentRunDiagnostics(
    params.ingressOpts.sessionKey,
    params.isIncognito,
    params.context.logGateway,
  );
  const assertSettlementCurrent = params.assertSettlementCurrent;
  const registeredRunEntry = params.admittedRunEntry;
  const jobSessionBinding = registeredRunEntry ?? params.ingressOpts;
  let runOwnerSettled = false;
  let pendingReplay: DedupeEntry | undefined;
  const publishReplay = (entry: DedupeEntry) => {
    if (!runOwnerSettled) {
      pendingReplay = entry;
      return;
    }
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.dedupeKeys,
      session: captureAgentJobSession(jobSessionBinding),
      entry: diagnostics.forReplay(entry),
    });
  };
  const registeredRunInstance = registeredRunEntry?.operationalRunInstance;
  const registeredLifecycleGeneration = registeredRunEntry?.lifecycleGeneration;
  const registeredSessionKey = registeredRunEntry?.sessionKey;
  const ownsRunRegistration = () => {
    const current = params.context.chatAbortControllers.get(params.runId);
    return (
      !current ||
      (current === registeredRunEntry &&
        current.controller === params.abortController &&
        current.operationalRunInstance === registeredRunInstance &&
        current.lifecycleGeneration === registeredLifecycleGeneration &&
        current.sessionKey === registeredSessionKey)
    );
  };
  const assertCurrent = () => {
    // Preserve the run's recorded cancellation before a retired source rejects its authority.
    params.abortController.signal.throwIfAborted();
    params.assertCurrent?.();
    params.abortController.signal.throwIfAborted();
  };
  const followupCompletion = params.followupCompletion;
  const settleFollowup = async (reply: FollowupReply) => {
    if (!followupCompletion?.ownsExecution(params.runId)) {
      return;
    }
    try {
      await followupCompletion.settle(params.runId, reply, () => {
        assertSettlementCurrent?.();
        const current = params.context.chatAbortControllers.get(params.runId);
        // Another session may reuse the run ID without adopting this retained result.
        if (
          !ownsRunRegistration() &&
          (current === registeredRunEntry || current?.sessionKey === registeredSessionKey)
        ) {
          throw new Error("Followup physical execution lost its Gateway registration.");
        }
      });
    } catch (error) {
      followupCompletion.close(error);
      throw error;
    }
  };

  const settle = async (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }): Promise<boolean> => {
    try {
      return (await params.onSettled?.(outcome)) ?? true;
    } catch (error) {
      diagnostics.warning(`failed to settle agent continuation ${params.runId}`)(error);
      return false;
    }
  };
  let runOwnerCleanedUp = false;
  let runOwnerCleanup: Promise<void> | undefined;
  const cleanupRunOwner = () => {
    if (runOwnerCleanedUp) {
      return runOwnerCleanup;
    }
    runOwnerCleanedUp = true;
    if (ownsRunRegistration()) {
      clearAgentRunContext(params.runId, params.ingressOpts.lifecycleGeneration);
    }
    return (runOwnerCleanup = Promise.resolve(params.cleanupAbortController()).then(() => {
      runOwnerSettled = true;
      // Recovery can replace the replay while finish is pending; publish through this same owner.
      if (pendingReplay) {
        const entry = pendingReplay;
        pendingReplay = undefined;
        publishReplay(entry);
      }
    }));
  };
  const cronCreatorAuthorityCapability = params.cronCreatorAuthority
    ? createCronCreatorAuthorityCapability(
        params.cronCreatorAuthority.runId,
        params.cronCreatorAuthority.callerOrigin,
        params.cronCreatorAuthority.managementEntitlement,
        params.cronCreatorAuthority.isCurrent,
        undefined,
        params.cronCreatorAuthority.requesterOwner,
        params.cronCreatorAuthority.callerScopedCreation,
      )
    : undefined;
  if (cronCreatorAuthorityCapability) {
    params.cronCreatorAuthority?.bindRunScope?.(cronCreatorAuthorityCapability);
  }
  const producerRunInstance = registeredRunEntry?.operationalRunInstance;
  const producerLifecycleGeneration = registeredRunEntry?.lifecycleGeneration;
  const producerSessionKey = registeredRunEntry?.sessionKey;
  const producerCompletion = createDeferredCore();
  let terminalSettlement: Promise<void> | undefined;
  if (registeredRunEntry && params.ingressOpts.abortSignal === params.abortController.signal) {
    registeredRunEntry.resolveTerminalProducer = () => {
      const { sessionId, sessionKey } = registeredRunEntry;
      const isCurrent = () => {
        const authority = registeredRunEntry.agentRunDelegatedAuthority;
        return (
          !runOwnerCleanedUp &&
          !params.abortController.signal.aborted &&
          params.ingressOpts.abortSignal === params.abortController.signal &&
          params.context.chatAbortControllers.get(params.runId) === registeredRunEntry &&
          registeredRunEntry.controller === params.abortController &&
          registeredRunEntry.operationalRunInstance === producerRunInstance &&
          registeredRunEntry.lifecycleGeneration === producerLifecycleGeneration &&
          registeredRunEntry.sessionId === sessionId &&
          registeredRunEntry.sessionKey === sessionKey &&
          sessionKey === producerSessionKey &&
          !registeredRunEntry.registrationCleanupRequested &&
          (!producerLifecycleGeneration ||
            isAgentEventLifecycleGenerationCurrent(producerLifecycleGeneration)) &&
          (!registeredRunEntry.executionStarted || authority !== undefined) &&
          (!authority ||
            (authority.operationalRunInstance === producerRunInstance &&
              validateAgentRunDelegatedAuthority(authority)))
        );
      };
      if (!isCurrent()) {
        return undefined;
      }
      return {
        sessionId,
        sessionKey,
        handoff: (settle) => {
          if (!isCurrent()) {
            return false;
          }
          const settlement = settle(producerCompletion.promise);
          terminalSettlement = terminalSettlement
            ? Promise.all([terminalSettlement, settlement]).then(() => undefined)
            : settlement;
          return true;
        },
      };
    };
  }
  const completeTerminalProducer = async () => {
    producerCompletion.resolve();
    let joined: Promise<void> | undefined;
    do {
      joined = terminalSettlement;
      await joined;
    } while (joined !== terminalSettlement);
  };
  const activateAgent = (
    commentaryMedia?: ReturnType<typeof createAssistantCommentaryMediaCustody>,
  ) => {
    assertCurrent();
    const ingressOptsWithSpawnFacts = withAgentCommandExecutionIdentitySpawnFacts(
      {
        ...params.ingressOpts,
        ...(commentaryMedia
          ? { prepareAssistantTranscriptMessage: commentaryMedia.prepareAssistantTranscriptMessage }
          : {}),
        beforeTerminalDelivery: completeTerminalProducer,
      },
      readAgentRunDispatchExecutionIdentity(params),
    );
    const invoke = () =>
      runWithCanonicalSkillWorkspace(params.canonicalSkillWorkspaceDir, () =>
        agentCommandFromGatewayIngress(
          cronCreatorAuthorityCapability
            ? { ...ingressOptsWithSpawnFacts, cronCreatorAuthorityCapability }
            : ingressOptsWithSpawnFacts,
          diagnostics.runtime,
          params.context.deps,
          { restoreAdmittedRecovery: params.restoreAdmittedRecovery },
          params.commandRuntimeContext,
        ),
      );
    if (followupCompletion) {
      if (
        !registeredRunEntry ||
        !ownsRunRegistration() ||
        params.context.chatAbortControllers.get(params.runId) !== registeredRunEntry ||
        registeredRunEntry.registrationCleanupRequested
      ) {
        throw new Error("Followup no longer owns its Gateway run registration.");
      }
      followupCompletion.assertExecutionCurrent(params.runId);
    }
    return commentaryMedia ? commentaryMedia.run(invoke) : invoke();
  };
  const runAgent = () => {
    try {
      assertCurrent();
      return params.loadCommentaryMedia
        ? params.loadCommentaryMedia().then(activateAgent)
        : activateAgent();
    } catch (error) {
      const failure = toErrorObject(error, formatErrorMessage(error));
      if (!(error instanceof Error)) {
        failure.cause = error;
      }
      return Promise.reject(failure);
    }
  };
  const agentExecution = cronCreatorAuthorityCapability
    ? runWithCronCreatorAuthorityCapability(
        cronCreatorAuthorityCapability,
        runAgent,
        params.abortController.signal,
      )
    : runAgent();
  // Startup failures may never enter command finalization; delivery already joined this boundary.
  const agentRun = agentExecution.finally(completeTerminalProducer);
  let inputCompletionWriteFailed = false;
  const dispatchCompletion = agentRun
    .then(async (result) => {
      const recordedOutcome = readAgentRunTerminalOutcome(result);
      const signalStopReason = resolveResolvedAgentTimeoutStopReason(
        result?.meta,
        params.abortController.signal,
      );
      const aborted = result?.meta?.aborted === true || signalStopReason !== undefined;
      const stopReason = signalStopReason
        ? signalStopReason
        : aborted
          ? (result?.meta?.stopReason ?? "rpc")
          : undefined;
      const timeoutPhase = normalizeAgentRunTimeoutPhase(result?.meta?.timeoutPhase);
      const terminalError = readAgentRunTerminalError(result) ?? result?.meta?.error?.message;
      let terminalOutcome = buildAgentRunTerminalOutcome({
        status:
          aborted || result?.meta?.stopReason === "timeout" || timeoutPhase
            ? "timeout"
            : recordedOutcome === "failed" ||
                result?.meta?.error ||
                result?.meta?.stopReason === "error"
              ? "error"
              : "ok",
        error: terminalError ? formatErrorMessage(terminalError) : undefined,
        stopReason: stopReason ?? result?.meta?.stopReason,
        livenessState: result?.meta?.livenessState,
        timeoutPhase,
        providerStarted: result?.meta?.providerStarted,
      });
      let recordedInputCompletion: AgentRunTerminalOutcome | undefined;
      try {
        recordedInputCompletion = await completeUserTurnProcessing(
          params.ingressOpts.userTurnTranscriptRecorder,
          terminalOutcome,
        );
        terminalOutcome = recordedInputCompletion ?? terminalOutcome;
      } catch (error) {
        inputCompletionWriteFailed = true;
        throw error;
      }
      const responseStatus =
        RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION[
          classifyAgentRunTerminalOutcome(terminalOutcome)
        ];
      const terminalReply = normalizeAgentRunTerminalReplySnapshot(result?.meta?.terminalReply);
      const receipt = normalizeAgentRunTerminalReceipt(result?.meta?.agentMeta?.terminalReceipt);
      await settleFollowup({
        ...terminalOutcome,
        endedAt: terminalOutcome.endedAt ?? Date.now(),
        yielded: result?.meta?.yielded === true,
        terminalReply,
        ...(terminalReply?.disposition === "visible" ? { replyText: terminalReply.text } : {}),
        ...(receipt?.runId === params.runId && receipt.sourceReplyDelivered
          ? { sourceReplyDelivered: true as const }
          : {}),
      });
      const inputProcessingCompleted =
        recordedInputCompletion?.reason === "completed" && responseStatus === "ok";
      const payload = {
        runId: params.runId,
        status: responseStatus,
        summary:
          responseStatus === "timeout"
            ? "aborted"
            : responseStatus === "error"
              ? "failed"
              : "completed",
        ...(responseStatus !== "ok" && terminalOutcome.stopReason
          ? { stopReason: terminalOutcome.stopReason }
          : {}),
        ...(responseStatus === "timeout" && terminalOutcome.timeoutPhase
          ? { timeoutPhase: terminalOutcome.timeoutPhase }
          : {}),
        ...(responseStatus === "timeout" && terminalOutcome.providerStarted !== undefined
          ? { providerStarted: terminalOutcome.providerStarted }
          : {}),
        result,
        ...(inputProcessingCompleted ? { inputProcessingCompleted: true } : {}),
      };
      const persistTerminalDedupe = () => {
        publishReplay({
          ts: Date.now(),
          ok: true,
          payload: { ...payload },
        });
      };
      const settled = await settle({ terminalOutcome, onRecovered: persistTerminalDedupe });
      if (!settled) {
        const summary = "failed to persist cron continuation settlement";
        const error = errorShape(ErrorCodes.UNAVAILABLE, summary);
        const failedPayload = { runId: params.runId, status: "error" as const, summary };
        publishReplay({
          ts: Date.now(),
          ok: false,
          payload: failedPayload,
          error,
        });
        await cleanupRunOwner();
        params.io.emitFinal([false, failedPayload, error], {
          runId: params.runId,
          error: summary,
        });
        return { terminalOutcome, settled };
      }
      persistTerminalDedupe();
      // A final response resumes durable delivery cleanup. Release the terminal
      // run owner first so exact-session deletion cannot race this admission.
      await cleanupRunOwner();
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.io.emitFinal([true, { ...payload }, undefined], { runId: params.runId });
      return { terminalOutcome, settled };
    })
    .catch(async (cause: unknown) => {
      const aborted = isGatewayAgentAbortRejection(cause, params.abortController.signal);
      const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, cause);
      const renderedErr = error.message;
      const stopReason = aborted
        ? resolveGatewayAgentAbortStopReason(params.abortController.signal)
        : isAbortError(cause)
          ? "aborted"
          : undefined;
      let terminalOutcome = buildAgentRunTerminalOutcome({
        status: aborted || isTimeoutError(cause) ? "timeout" : "error",
        error: renderedErr,
        stopReason,
        timeoutPhase: stopReason === "restart" ? "gateway_draining" : undefined,
      });
      // A failed required write cannot be its own retry loop. Publish failure
      // and release the accepted owner even while the receipt store is unavailable.
      if (!inputCompletionWriteFailed) {
        try {
          terminalOutcome =
            (await completeUserTurnProcessing(
              params.ingressOpts.userTurnTranscriptRecorder,
              terminalOutcome,
            )) ?? terminalOutcome;
        } catch (completionError) {
          diagnostics.warning("input completion persistence failed")(completionError);
        }
      }
      const responseStatus = projectRejectedGatewayStatus(terminalOutcome);
      await settleFollowup({
        ...terminalOutcome,
        error: renderedErr,
        endedAt: terminalOutcome.endedAt ?? Date.now(),
      });
      Object.defineProperty(error, "cause", { value: cause });
      const payload = {
        runId: params.runId,
        status: responseStatus,
        summary: aborted ? "aborted" : renderedErr,
        ...(aborted
          ? {
              stopReason,
              ...(terminalOutcome.timeoutPhase
                ? { timeoutPhase: terminalOutcome.timeoutPhase }
                : {}),
            }
          : {}),
      };
      const persistTerminalDedupe = (settlementPersisted: boolean) => {
        publishReplay({
          ts: Date.now(),
          ok: aborted && settlementPersisted,
          payload,
          ...(aborted ? {} : { error }),
        });
      };
      const settled = await settle({
        terminalOutcome,
        onRecovered: () => persistTerminalDedupe(true),
      });
      persistTerminalDedupe(settled);
      await cleanupRunOwner();
      const responseError = aborted && settled ? undefined : error;
      params.io.emitFinal([aborted && settled, payload, responseError], {
        runId: params.runId,
        ...diagnostics.errorMeta(responseError?.message, !aborted),
      });
      return { terminalOutcome, settled };
    });
  const runCompletion = (async () => {
    try {
      return await dispatchCompletion;
    } finally {
      try {
        await cleanupRunOwner();
      } finally {
        followupCompletion?.finishExecution(params.runId);
      }
    }
  })();

  // Gateway shutdown must join this execution, not just its admission.
  return runCompletion;
}
