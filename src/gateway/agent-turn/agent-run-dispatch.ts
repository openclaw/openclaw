import { normalizeAgentRunTimeoutPhase } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { withAgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";
import {
  buildAgentRunTerminalOutcome,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
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
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { captureAgentJobSession } from "./agent-job.js";
import { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import { readAgentRunDispatchExecutionIdentity } from "./agent-run-dispatch-execution-identity.js";
import { readFollowupTerminalReply } from "./agent-run-dispatch-followup.js";
import {
  isGatewayAgentAbortRejection,
  projectRejectedGatewayStatus,
  RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION,
  resolveGatewayAgentAbortStopReason,
  resolveResolvedAgentTimeoutStopReason,
} from "./agent-run-dispatch-outcome.js";
import { bindGatewayAgentTerminalProducer } from "./agent-run-terminal-producer.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

export function resolveAbortedAgentStopReason(entry?: ChatAbortControllerEntry): string {
  return entry?.abortStopReason?.trim() || "rpc";
}

export function dispatchAgentRunFromGateway(params: {
  assertCurrent?: () => void;
  assertSettlementCurrent?: () => void;
  followupCompletion?: FollowupCompletionOwner;
  admittedRunEntry: ChatAbortControllerEntry | undefined;
  ingressOpts: Parameters<typeof agentCommandFromGatewayIngress>[0];
  runId: string;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  cleanupAbortController: () => void;
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
  const cleanupRunOwner = () => {
    if (runOwnerCleanedUp) {
      return;
    }
    runOwnerCleanedUp = true;
    if (ownsRunRegistration()) {
      clearAgentRunContext(params.runId, params.ingressOpts.lifecycleGeneration);
    }
    params.cleanupAbortController();
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
  const terminalProducer = bindGatewayAgentTerminalProducer({
    runId: params.runId,
    entry: registeredRunEntry,
    controller: params.abortController,
    ingressOpts: params.ingressOpts,
    chatAbortControllers: params.context.chatAbortControllers,
    isOwnerReleased: () => runOwnerCleanedUp,
  });
  const ingressOptsWithSpawnFacts = withAgentCommandExecutionIdentitySpawnFacts(
    { ...params.ingressOpts, beforeTerminalDelivery: terminalProducer.complete },
    readAgentRunDispatchExecutionIdentity(params),
  );
  const activateAgent = () => {
    assertCurrent();
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
    return invoke();
  };
  const runAgent = () => {
    try {
      assertCurrent();
      return activateAgent();
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
  const agentRun = terminalProducer.settle(agentExecution);
  let inputCompletionWriteFailed = false;
  const runCompletion = agentRun
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
        recordedInputCompletion =
          params.ingressOpts.userTurnTranscriptRecorder?.completeProcessing?.(terminalOutcome);
        terminalOutcome = recordedInputCompletion ?? terminalOutcome;
      } catch (error) {
        inputCompletionWriteFailed = true;
        throw error;
      }
      const responseStatus =
        RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION[
          classifyAgentRunTerminalOutcome(terminalOutcome)
        ];
      await settleFollowup({
        ...terminalOutcome,
        endedAt: terminalOutcome.endedAt ?? Date.now(),
        yielded: result?.meta?.yielded === true,
        ...readFollowupTerminalReply(params.runId, result?.meta),
      });
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
      };
      const inputProcessingCompleted =
        recordedInputCompletion?.reason === "completed" && responseStatus === "ok";
      const persistTerminalDedupe = () => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: diagnostics.forReplay({
            ts: Date.now(),
            ok: true,
            payload: {
              ...payload,
              ...(inputProcessingCompleted ? { inputProcessingCompleted: true } : {}),
            },
          }),
        });
      };
      const settled = await settle({ terminalOutcome, onRecovered: persistTerminalDedupe });
      if (!settled) {
        const summary = "failed to persist cron continuation settlement";
        const error = errorShape(ErrorCodes.UNAVAILABLE, summary);
        const failedPayload = { runId: params.runId, status: "error" as const, summary };
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: diagnostics.forReplay({
            ts: Date.now(),
            ok: false,
            payload: failedPayload,
            error,
          }),
        });
        cleanupRunOwner();
        params.io.emitFinal([false, failedPayload, error], {
          runId: params.runId,
          error: summary,
        });
        return { terminalOutcome, settled };
      }
      persistTerminalDedupe();
      // A final response resumes durable delivery cleanup. Release the terminal
      // run owner first so exact-session deletion cannot race this admission.
      cleanupRunOwner();
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.io.emitFinal(
        [
          true,
          { ...payload, ...(inputProcessingCompleted ? { inputProcessingCompleted: true } : {}) },
          undefined,
        ],
        { runId: params.runId },
      );
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
            params.ingressOpts.userTurnTranscriptRecorder?.completeProcessing?.(terminalOutcome) ??
            terminalOutcome;
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
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: diagnostics.forReplay({
            ts: Date.now(),
            ok: aborted && settlementPersisted,
            payload,
            ...(aborted ? {} : { error }),
          }),
        });
      };
      const settled = await settle({
        terminalOutcome,
        onRecovered: () => persistTerminalDedupe(true),
      });
      persistTerminalDedupe(settled);
      cleanupRunOwner();
      const responseError = aborted && settled ? undefined : error;
      params.io.emitFinal([aborted && settled, payload, responseError], {
        runId: params.runId,
        ...diagnostics.errorMeta(responseError?.message, !aborted),
      });
      return { terminalOutcome, settled };
    })
    .finally(() => {
      try {
        cleanupRunOwner();
      } finally {
        followupCompletion?.finishExecution(params.runId);
      }
    });

  // Gateway shutdown must join this execution, not just its admission.
  return runCompletion;
}
