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
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import {
  getRpcSource,
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceStartedAt,
  hasRpcSource,
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { readWithdrawnUserTurnInputId } from "../../sessions/user-turn-transcript-admission.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
  projectWithdrawnAgentInput,
  RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION,
  resolveGatewayAgentAbortStopReason,
  resolveResolvedAgentTimeoutStopReason,
} from "./agent-run-dispatch-outcome.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

type AgentRunMediaCustody = Pick<
  ReturnType<typeof createAssistantCommentaryMediaCustody>,
  "run" | "prepareAssistantTranscriptMessage"
> & {
  finalize: NonNullable<
    Parameters<typeof agentCommandFromGatewayIngress>[0]["beforeTerminalDelivery"]
  >;
};

export function dispatchAgentRunFromGateway(params: {
  assertCurrent?: () => void;
  assertSettlementCurrent?: () => void;
  followupCompletion?: FollowupCompletionOwner;
  admittedRunEntry: RpcSourceRef | undefined;
  ingressOpts: Parameters<typeof agentCommandFromGatewayIngress>[0];
  loadMedia?: () => Promise<AgentRunMediaCustody | undefined>;
  runId: string;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to retire the matching controller source without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: Pick<AbortController, "signal" | "abort">;
  cleanupAbortController: () => void | Promise<void>;
  io: AgentTurnIo;
  context: AgentTurnContext;
  canonicalSkillWorkspaceDir?: string;
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
  const captureJobSession = () =>
    captureAgentJobSession(
      registeredRunEntry
        ? {
            ...getRpcSourceIdentity(registeredRunEntry),
            lifecycleGeneration: getRpcSourceLifecycleGeneration(registeredRunEntry),
          }
        : params.ingressOpts,
    );
  let runOwnerSettled = false;
  const projectInputOutcome = (payload: unknown) =>
    projectWithdrawnAgentInput(
      payload,
      readWithdrawnUserTurnInputId(params.ingressOpts.userTurnTranscriptRecorder),
      registeredRunEntry?.adapter.abortStopReason,
    );
  let pendingReplay: DedupeEntry | undefined;
  const publishReplay = (entry: DedupeEntry) => {
    if (!runOwnerSettled) {
      pendingReplay = entry;
      return;
    }
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.dedupeKeys,
      session: captureJobSession(),
      entry: diagnostics.forReplay({ ...entry, payload: projectInputOutcome(entry.payload) }),
    });
  };
  const registeredRunInstance = registeredRunEntry?.adapter.operationalRunInstance;
  const registeredLifecycleGeneration =
    registeredRunEntry && getRpcSourceLifecycleGeneration(registeredRunEntry);
  const registeredSessionKey =
    registeredRunEntry && getRpcSourceIdentity(registeredRunEntry).sessionKey;
  const currentRunRegistration = () =>
    getRpcSourceForGateway(
      params.runId,
      params.context.resolveGatewayContext,
      registeredRunEntry?.input.target,
    );
  const ownsRunRegistration = () => {
    const current = currentRunRegistration();
    return (
      !current ||
      (current === registeredRunEntry &&
        current.input.abortSignal === params.abortController.signal &&
        current.adapter.operationalRunInstance === registeredRunInstance &&
        getRpcSourceLifecycleGeneration(current) === registeredLifecycleGeneration &&
        getRpcSourceIdentity(current).sessionKey === registeredSessionKey)
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
        const current = currentRunRegistration();
        // Another session may reuse the run ID without adopting this retained result.
        if (
          !ownsRunRegistration() &&
          (current === registeredRunEntry ||
            (current && getRpcSourceIdentity(current).sessionKey === registeredSessionKey))
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
    // Contexts are indexed by run ID, even when a replacement belongs to another session.
    const ownsGlobalRegistration =
      !hasRpcSource(params.runId) ||
      (registeredRunEntry !== undefined && getRpcSource(params.runId) === registeredRunEntry);
    if (ownsGlobalRegistration && ownsRunRegistration()) {
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
    ? (params.cronCreatorAuthority.boundRunScope ??
      createCronCreatorAuthorityCapability(
        params.cronCreatorAuthority.runId,
        params.cronCreatorAuthority.callerOrigin,
        params.cronCreatorAuthority.managementEntitlement,
        params.cronCreatorAuthority.isCurrent,
        undefined,
        params.cronCreatorAuthority.requesterOwner,
        params.cronCreatorAuthority.callerScopedCreation,
      ))
    : undefined;
  if (cronCreatorAuthorityCapability && !params.cronCreatorAuthority?.boundRunScope) {
    params.cronCreatorAuthority?.bindRunScope?.(cronCreatorAuthorityCapability);
  }
  /** Binds canonical transcript settlement to the exact registered API producer. */
  const entry = registeredRunEntry;
  const controller = params.abortController;
  const ingressOpts = params.ingressOpts;
  const producerRunInstance = entry?.adapter.operationalRunInstance;
  const producerLifecycleGeneration = entry && getRpcSourceLifecycleGeneration(entry);
  const producerSessionKey = entry && getRpcSourceIdentity(entry).sessionKey;
  const producerCompletion = createDeferredCore<unknown>();
  let terminalSettlement: Promise<void> | undefined;
  if (entry && ingressOpts.abortSignal === controller.signal) {
    entry.adapter.resolveTerminalProducer = () => {
      const { sessionId, sessionKey } = getRpcSourceIdentity(entry);
      const isCurrent = () => {
        const authority = entry.adapter.agentRunDelegatedAuthority;
        return (
          !runOwnerCleanedUp &&
          !controller.signal.aborted &&
          ingressOpts.abortSignal === controller.signal &&
          isRpcSourceRegistered(entry) &&
          entry.input.abortSignal === controller.signal &&
          entry.adapter.operationalRunInstance === producerRunInstance &&
          getRpcSourceLifecycleGeneration(entry) === producerLifecycleGeneration &&
          getRpcSourceIdentity(entry).sessionId === sessionId &&
          getRpcSourceIdentity(entry).sessionKey === sessionKey &&
          sessionKey === producerSessionKey &&
          !entry.input.retirementRequested &&
          (!producerLifecycleGeneration ||
            isAgentEventLifecycleGenerationCurrent(producerLifecycleGeneration)) &&
          (getRpcSourceStartedAt(entry) === undefined || authority !== undefined) &&
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
        handoff: (settleProducer) => {
          if (!isCurrent()) {
            return false;
          }
          const settlement = settleProducer(producerCompletion.promise);
          terminalSettlement = terminalSettlement
            ? Promise.all([terminalSettlement, settlement]).then(() => undefined)
            : settlement;
          return true;
        },
      };
    };
  }
  const complete = async (producerError?: unknown) => {
    producerCompletion.resolve(producerError);
    let joined: Promise<void> | undefined;
    do {
      joined = terminalSettlement;
      await joined;
    } while (joined !== terminalSettlement);
  };
  const terminalProducer = {
    complete,
    async settle<T>(execution: Promise<T>): Promise<T> {
      let producerError: unknown;
      try {
        return await execution;
      } catch (error) {
        producerError = error;
        throw error;
      } finally {
        await complete(producerError);
      }
    },
  };
  const activateAgent = (media?: AgentRunMediaCustody) => {
    assertCurrent();
    const ingressOptsWithSpawnFacts = withAgentCommandExecutionIdentitySpawnFacts(
      {
        ...params.ingressOpts,
        ...(media
          ? { prepareAssistantTranscriptMessage: media.prepareAssistantTranscriptMessage }
          : {}),
        beforeTerminalDelivery: async (reply, producerError) => {
          try {
            await media?.finalize(reply);
          } finally {
            await terminalProducer.complete(producerError);
          }
        },
        isTerminalOutcomeObserved: () =>
          registeredRunEntry?.adapter.terminalOutcomeObserved === true,
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
          params.commandRuntimeContext,
        ),
      );
    if (followupCompletion) {
      if (
        !registeredRunEntry ||
        !ownsRunRegistration() ||
        !isRpcSourceRegistered(registeredRunEntry) ||
        registeredRunEntry.input.retirementRequested
      ) {
        throw new Error("Followup no longer owns its Gateway run registration.");
      }
      followupCompletion.assertExecutionCurrent(params.runId);
    }
    return media ? media.run(invoke) : invoke();
  };
  const runAgent = () => {
    try {
      assertCurrent();
      return params.loadMedia ? params.loadMedia().then(activateAgent) : activateAgent();
    } catch (error) {
      const failure = toErrorObject(error, formatErrorMessage(error));
      if (!(error instanceof Error)) {
        failure.cause = error;
      }
      return Promise.reject(failure);
    }
  };
  const runOwnedAgent = () =>
    withExecRequestTurn(
      {
        identity: {
          runId: params.runId,
          sessionKey: registeredRunEntry && getRpcSourceIdentity(registeredRunEntry).sessionKey,
          sessionId: registeredRunEntry && getRpcSourceIdentity(registeredRunEntry).sessionId,
          agentId: registeredRunEntry && getRpcSourceIdentity(registeredRunEntry).agentId,
          ownerConnId: registeredRunEntry?.adapter.requester?.connectionId,
          ownerDeviceId: registeredRunEntry?.adapter.requester?.deviceId,
          initiatingPersonalOperator: registeredRunEntry?.adapter.initiatingPersonalOperator,
          controlUiVisible: registeredRunEntry?.adapter.controlUiVisible,
          turnKind: registeredRunEntry?.adapter.turnKind,
        },
        abortSignal: params.abortController.signal,
      },
      runAgent,
    );
  const agentExecution = cronCreatorAuthorityCapability
    ? runWithCronCreatorAuthorityCapability(
        cronCreatorAuthorityCapability,
        runOwnedAgent,
        params.abortController.signal,
      )
    : runOwnedAgent();
  // Startup failures may never enter command finalization; delivery already joined this boundary.
  const agentRun = (async () => {
    let producerError: unknown;
    try {
      return await agentExecution;
    } catch (error) {
      producerError = error;
      throw error;
    } finally {
      await terminalProducer.complete(producerError);
    }
  })();
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
        ...(terminalReply?.disposition === "visible"
          ? { replyText: result?.meta?.finalAssistantVisibleText ?? terminalReply.text }
          : {}),
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
          payload,
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
      params.io.emitFinal([true, projectInputOutcome(payload), undefined], { runId: params.runId });
      return { terminalOutcome, settled };
    })
    .catch(async (cause: unknown) => {
      const operation = params.admittedRunEntry?.input.claim?.operation;
      const controllerAbortCommitted =
        operation?.result?.kind === "aborted" &&
        isGatewayAgentAbortRejection(operation.abortSignal.reason, operation.abortSignal);
      const aborted =
        controllerAbortCommitted ||
        isGatewayAgentAbortRejection(cause, params.abortController.signal);
      const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, cause);
      const renderedErr = error.message;
      const stopReason = aborted
        ? resolveGatewayAgentAbortStopReason(params.abortController.signal, cause)
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
      params.io.emitFinal([aborted && settled, projectInputOutcome(payload), responseError], {
        runId: params.runId,
        ...diagnostics.errorMeta(responseError?.message, !aborted),
      });
      return { terminalOutcome, settled };
    });
  // Gateway shutdown must join this execution, not just its admission.
  return (async () => {
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
}
