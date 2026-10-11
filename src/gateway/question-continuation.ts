import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionAccessScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  SessionQuestionCustodyRetiredError,
  hasSessionQuestionCustodyRetiredError,
} from "../config/sessions/session-questions-custody-error.js";
import {
  executeSessionQuestionOperation,
  readSessionQuestionCustody,
} from "../config/sessions/session-questions.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { hasSqliteWorkerErrorCode } from "../infra/sqlite-worker-contract.js";
import { CommandLane } from "../process/lanes.js";
import { prepareChannelOperatorAdmin } from "./channel-operator-authority.js";
import { captureChannelOperatorRunAuthority } from "./operator-run-authority.js";
import { restoreGatewayQuestionOperatorRecovery } from "./operator-run-recovery.js";
import type { QuestionAdmissionRetry } from "./question-continuation-work.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

export type QuestionCompletionOwed = {
  status: "completion_owed";
  questionId: string;
  runId: string;
  repair: () => Promise<void>;
};

export type QuestionTerminalOwed = {
  status: "terminal_owed";
  questionId: string;
  runId: string;
  repair: () => Promise<void>;
};

export type QuestionReceiptOwed = QuestionCompletionOwed | QuestionTerminalOwed;

export type QuestionContinuationReceipt =
  | (QuestionAdmissionRetry & { questionId: string })
  | QuestionReceiptOwed
  | { status: "settled"; questionId: string; runId: string }
  | { status: "interrupted"; questionId: string; runId: string }
  | { status: "not_owed"; questionId: string };

/** One native turn owns each committed answer. The existing lane handles busy sessions. */
export async function dispatchQuestionContinuation(params: {
  question: DurableQuestion;
  scope: SessionAccessScope & { storePath: string };
  context: GatewayRequestContext;
  runtime: GatewayInstanceRuntime;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<QuestionContinuationReceipt> {
  const { question, scope, context, runtime } = params;
  const questionId = question.record.id;
  if (question.continuation.status !== "owed") {
    return { status: "not_owed", questionId };
  }
  const runId = randomUUID();
  const epoch = getAgentEventLifecycleGeneration();
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (!runtime.isAvailable() || getAgentEventLifecycleGeneration() !== epoch) {
      throw new Error("Durable question Gateway owner changed.");
    }
  };
  // Recovery owns crash-loop quarantine. Keep custody owed until that owner allows admission.
  assertCurrent();
  let retryAtMs: number | undefined;
  try {
    retryAtMs = await runtime.recovery.prepareRestartRecovery(params.signal);
  } catch {
    assertCurrent();
    return { status: "admission_owed", questionId };
  }
  assertCurrent();
  if (retryAtMs !== undefined) {
    return { status: "admission_owed", questionId, retryAtMs };
  }
  let expectedQuestion = question;
  let executionCompleted = false;
  let claimed = false;
  let claimAttempted = false;
  let restored: Awaited<ReturnType<typeof restoreGatewayQuestionOperatorRecovery>> = undefined;
  const isOwnReceipt = (
    current: DurableQuestion | DurableQuestion[] | undefined,
  ): current is DurableQuestion =>
    Boolean(
      current &&
      !Array.isArray(current) &&
      current.continuation.runId === runId &&
      current.continuation.gatewayEpoch === epoch &&
      current.sessionKey === expectedQuestion.sessionKey &&
      current.sessionId === expectedQuestion.sessionId &&
      current.lifecycleRevision === expectedQuestion.lifecycleRevision &&
      isDeepStrictEqual(current.provenance, expectedQuestion.provenance) &&
      isDeepStrictEqual(current.sessionBinding, expectedQuestion.sessionBinding) &&
      isDeepStrictEqual(current.record, expectedQuestion.record) &&
      current.resolutionId === expectedQuestion.resolutionId,
    );
  const finish = async (interrupted: boolean, reason?: string) => {
    const result = await executeSessionQuestionOperation(
      { ...scope, assertCurrent },
      { kind: "finish", id: questionId, runId, interrupted, reason, expectedQuestion },
    );
    if (
      !isOwnReceipt(result) ||
      result.continuation.status !== (interrupted ? "interrupted" : "settled") ||
      (interrupted && result.continuation.reason !== reason)
    ) {
      throw new Error("Durable question completion receipt was not settled.");
    }
  };
  try {
    assertCurrent();
    const freshResult = await readSessionQuestionCustody(
      question.sessionBinding,
      questionId,
      assertCurrent,
    );
    const fresh = Array.isArray(freshResult) ? undefined : freshResult;
    if (
      !fresh ||
      fresh.continuation.status !== "owed" ||
      fresh.sessionId !== question.sessionId ||
      fresh.lifecycleRevision !== question.lifecycleRevision ||
      !isDeepStrictEqual(fresh.provenance, question.provenance) ||
      !isDeepStrictEqual(fresh.sessionBinding, question.sessionBinding) ||
      !isDeepStrictEqual(fresh.record, question.record) ||
      fresh.resolutionId !== question.resolutionId
    ) {
      throw new Error("Durable question source custody changed.");
    }
    expectedQuestion = fresh;
    const source = fresh.provenance.recoverySource;
    let authority;
    let agentId = scope.agentId;
    if (fresh.provenance.issuer === "operator" && source) {
      restored = await restoreGatewayQuestionOperatorRecovery({
        questionId,
        expectedQuestion,
        target: {
          agentId: source.agentId,
          sessionKey: question.sessionKey,
          sessionId: question.sessionId,
          storePath: scope.storePath,
          sourceRunId: question.provenance.sourceRunId,
          recoveryRunId: runId,
        },
        context,
        assertCurrent,
      });
      authority = restored?.authority;
      agentId = source.agentId;
    } else if (
      fresh.provenance.issuer === "channel" &&
      fresh.provenance.channelAuthorizationReference
    ) {
      const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
      const channelOwner = await prepareChannelOperatorAdmin(
        getConfig(),
        fresh.provenance.channelAuthorizationReference,
      );
      assertCurrent();
      if (channelOwner) {
        const assertChannelCurrent = () => {
          assertCurrent();
          if (!channelOwner.isCurrent(getConfig())) {
            throw new Error("Durable question channel caller authority changed.");
          }
        };
        authority = captureChannelOperatorRunAuthority({
          ...channelOwner.operatorProfile,
          getRuntimeConfig: getConfig,
          assertCurrent: assertChannelCurrent,
          signal: channelOwner.signal,
          channelRecoveryReference: channelOwner.recoveryReference,
        });
      }
    }
    if (!authority) {
      throw new Error("Durable question original caller authority is unavailable.");
    }
    assertCurrent();
    const turns = await runtime.createAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: authority.profileId },
        operatorRunAuthority: authority,
        scopes: [...authority.scopes],
      }),
      assertContextCurrent: assertCurrent,
    });
    const delivery = question.provenance.delivery;
    await turns.dispatch(
      {
        agentId,
        sessionKey: question.sessionKey,
        expectedExistingSessionId: question.sessionId,
        expectedExistingSessionLifecycleRevision: question.lifecycleRevision,
        idempotencyKey: runId,
        lane: CommandLane.Main,
        message: `The previously requested user question has resolved. Continue the original task using this result:
${JSON.stringify({ id: questionId, status: question.record.status, answers: question.record.answers })}`,
        ...(delivery
          ? {
              channel: delivery.channel,
              to: delivery.to,
              accountId: delivery.accountId,
              threadId: delivery.threadId !== undefined ? String(delivery.threadId) : undefined,
              deliver: true,
            }
          : {}),
      },
      {
        expectFinal: true,
        assertAdmissionCurrent: () => {
          assertCurrent();
          authority.assertCurrent();
        },
        commitAdmission: async (target) => {
          if (
            target.runId !== runId ||
            target.lifecycleGeneration !== epoch ||
            target.storePath !== scope.storePath ||
            target.sessionId !== question.sessionId ||
            target.sessionKey !== question.sessionKey
          ) {
            throw new Error("Durable question target changed before admission.");
          }
          claimAttempted = true;
          const result = await executeSessionQuestionOperation(
            { ...scope, assertCurrent: target.assertCurrent },
            {
              kind: "claim",
              id: questionId,
              runId: target.runId,
              gatewayEpoch: epoch,
              expectedQuestion,
            },
          );
          if (
            !result ||
            Array.isArray(result) ||
            result.continuation.status !== "claimed" ||
            result.continuation.runId !== target.runId ||
            result.continuation.gatewayEpoch !== epoch ||
            result.sessionId !== question.sessionId ||
            result.lifecycleRevision !== question.lifecycleRevision
          ) {
            throw new Error("Durable question continuation claim was not admitted.");
          }
          claimed = true;
        },
      },
    );
    executionCompleted = true;
    restored?.release();
    restored = undefined;
    await finish(false);
    return { status: "settled", questionId, runId };
  } catch (error) {
    if (hasSessionQuestionCustodyRetiredError(error)) {
      throw error;
    }
    if (executionCompleted) {
      const repair = async () => {
        const canonical = await readSessionQuestionCustody(
          expectedQuestion.sessionBinding,
          questionId,
          assertCurrent,
        );
        if (
          !isOwnReceipt(canonical) ||
          (canonical.continuation.status !== "settled" &&
            canonical.continuation.status !== "claimed")
        ) {
          throw new SessionQuestionCustodyRetiredError(
            "Completed question receipt custody changed.",
          );
        }
        if (canonical.continuation.status === "settled") {
          return;
        }
        await finish(false);
      };
      // The native execution is complete. Preserve only its write-only receipt
      // obligation across storage outages; never reconstruct or repeat execution.
      try {
        await repair();
      } catch (repairError) {
        if (hasSessionQuestionCustodyRetiredError(repairError)) {
          throw repairError;
        }
        try {
          const repaired = await readSessionQuestionCustody(
            expectedQuestion.sessionBinding,
            questionId,
            assertCurrent,
          );
          if (
            !isOwnReceipt(repaired) ||
            (repaired.continuation.status !== "settled" &&
              repaired.continuation.status !== "claimed")
          ) {
            throw new SessionQuestionCustodyRetiredError(
              "Completed question receipt custody changed.",
            );
          }
          if (repaired.continuation.status === "settled") {
            return { status: "settled", questionId, runId };
          }
        } catch (readError) {
          if (hasSessionQuestionCustodyRetiredError(readError)) {
            throw readError;
          }
        }
        return { status: "completion_owed", questionId, runId, repair };
      }
      return { status: "settled", questionId, runId };
    }
    if (
      !claimAttempted &&
      hasSqliteWorkerErrorCode(error, ["closed", "overloaded", "unavailable", "outcome-unknown"])
    ) {
      // No native claim was attempted. Retry preparation only while the same
      // Gateway owns this exact custody; fresh policy still owns admission.
      assertCurrent();
      return { status: "admission_owed", questionId };
    }
    // Execution has ended (or admission was uncertain). Retain only terminal
    // persistence, never a source grant or permission to repeat the turn.
    restored?.release();
    restored = undefined;
    const interruptedReason =
      "Continuation was interrupted. Start a new user turn to inspect the current state; the previous turn will not automatically repeat.";
    const blockedReason =
      "Continuation could not be admitted under the original caller authority. Start a new user turn to inspect the question and current session.";
    const intent = claimed ? "interrupt" : claimAttempted ? "reconcile" : "block";
    const matchesCustody = (current: DurableQuestion | undefined): current is DurableQuestion =>
      Boolean(
        current &&
        current.sessionKey === expectedQuestion.sessionKey &&
        current.sessionId === expectedQuestion.sessionId &&
        current.lifecycleRevision === expectedQuestion.lifecycleRevision &&
        isDeepStrictEqual(current.record, expectedQuestion.record) &&
        isDeepStrictEqual(current.sessionBinding, expectedQuestion.sessionBinding) &&
        isDeepStrictEqual(current.provenance, expectedQuestion.provenance) &&
        current.resolutionId === expectedQuestion.resolutionId,
      );
    const repair = async () => {
      const canonical = await readSessionQuestionCustody(
        expectedQuestion.sessionBinding,
        questionId,
        assertCurrent,
      );
      if (!matchesCustody(canonical)) {
        throw new SessionQuestionCustodyRetiredError("Terminal question receipt custody changed.");
      }
      const status = canonical.continuation.status;
      if (status === "claimed" || status === "interrupted" || status === "settled") {
        if (!isOwnReceipt(canonical)) {
          // A different run won the same canonical obligation. Its projection
          // remains healthy; this old attempt owns neither a write nor a replay.
          if (intent !== "interrupt") {
            return;
          }
          throw new Error("Interrupted question receipt run owner changed.", { cause: error });
        }
        if (status === "interrupted" && canonical.continuation.reason === interruptedReason) {
          return;
        }
        if (status !== "claimed") {
          throw new Error("Question terminal receipt intent changed.", { cause: error });
        }
        await finish(true, interruptedReason);
        return;
      }
      if (status === "blocked") {
        if (intent !== "interrupt") {
          return;
        }
        throw new Error("Interrupted question receipt intent changed.", { cause: error });
      }
      if (status !== "owed" || intent === "interrupt") {
        throw new Error("Question terminal receipt is not owed.", { cause: error });
      }
      const blocked = await executeSessionQuestionOperation(
        { ...scope, assertCurrent },
        { kind: "block", id: questionId, expectedQuestion, reason: blockedReason },
      );
      if (
        Array.isArray(blocked) ||
        !matchesCustody(blocked) ||
        blocked.continuation.status !== "blocked" ||
        blocked.continuation.reason !== blockedReason
      ) {
        throw new Error("Question blocked receipt was not committed.", { cause: error });
      }
    };
    try {
      await repair();
    } catch (repairError) {
      if (hasSessionQuestionCustodyRetiredError(repairError)) {
        throw repairError;
      }
      assertCurrent();
      return { status: "terminal_owed", questionId, runId, repair };
    }
    throw error;
  } finally {
    restored?.release();
  }
}
