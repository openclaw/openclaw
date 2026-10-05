import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import { resumeMainSession } from "../../agents/main-session-recovery/main-session-restart-dispatch.js";
import {
  SessionGoalOperationError,
  type SessionGoalOperation,
} from "../../config/sessions/goals-operations.js";
import type { GoalRecoveryDecisionAdmission } from "../../config/sessions/main-session-recovery.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  captureGatewayOperatorRunAuthority,
  captureGatewayGoalIssuerAdmission,
  captureGatewayTurnIssuerAdmission,
} from "../operator-run-authority.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { recoverGatewaySession } from "../session-recovery-service.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** The recovery owner accepts a reviewed Goal turn before its existing dispatcher takes custody. */
export async function handleSessionGoalRecovery(
  options: GatewayRequestHandlerOptions,
  request: {
    agentId: string;
    sessionKey: string;
    operation: SessionGoalOperation & { action: "resume" };
    decision: GoalRecoveryDecisionAdmission;
  },
): Promise<void> {
  const { context, client, respond } = options;
  request.decision.assertCurrent();
  const captured = await captureGatewayOperatorRunAuthority({
    client,
    context,
    hasCurrentClientAuthority: options.hasCurrentClientAuthority,
    invocationAuthority: { assertCurrent: request.decision.assertCurrent },
  });
  if (!captured) {
    throw new SessionGoalOperationError(
      "recovery-decision-caller",
      "The original authenticated issuer is unavailable.",
    );
  }
  const authority = captured.authority;
  const assertCallerCurrent = () => {
    request.decision.assertCurrent();
    authority.assertCurrent();
  };
  try {
    const recovered = await recoverGatewaySession({
      cfg: context.getRuntimeConfig(),
      key: request.sessionKey,
      agentId: request.agentId,
      actor: resolveOperatorSessionCreation(client).actor,
      commitGuard: assertCallerCurrent,
      workerPlacementContext: resolveSessionWorkerPlacementContext(context),
      goalResume: {
        decision: request.decision,
        accept: async (source, assertCurrent, target) => {
          const basis = authority.captureRestartRecoveryIssuer?.();
          const original = source.mainRestartRecovery?.goalIntent;
          if (
            !basis ||
            !original ||
            original.goalId !== request.operation.goalId ||
            original.sessionId !== source.sessionId ||
            original.sessionKey !== target.canonicalKey ||
            original.lifecycleRevision !== source.lifecycleRevision ||
            !isDeepStrictEqual(basis, original.issuer)
          ) {
            throw new SessionGoalOperationError(
              "recovery-decision-caller",
              "The current caller does not match the original verified Goal issuer.",
            );
          }
          const guard = () => {
            assertCurrent();
            assertCallerCurrent();
          };
          const binding = {
            authority,
            sessionKey: target.canonicalKey,
            sessionId: source.sessionId,
            lifecycleRevision: source.lifecycleRevision,
            assertCurrent: guard,
          };
          const issuer = captureGatewayGoalIssuerAdmission(binding);
          if (!issuer) {
            throw new SessionGoalOperationError(
              "recovery-decision-caller",
              "Original Goal authority could not be captured.",
            );
          }
          const recorder = createUserTurnTranscriptRecorder({
            input: {
              text: request.operation.note
                ? `Continue the current Goal from its accepted checkpoint after the reviewed recovery decision. Inspect current state before repeating any action.\nOperator note: ${request.operation.note}`
                : "Continue the current Goal from its accepted checkpoint after the reviewed recovery decision. Inspect current state before repeating any action.",
              display: false,
              timestamp: Date.now(),
              idempotencyKey: buildRunUserTurnIdempotencyKey(request.operation.operationId),
            },
            pendingInputRequestFingerprint: request.operation.requestFingerprint,
            target: {
              agentId: target.agentId,
              sessionKey: target.canonicalKey,
              storePath: target.storePath,
              sessionId: source.sessionId,
              expectedSessionId: source.sessionId,
              sessionEntry: source,
              config: context.getRuntimeConfig(),
            },
          });
          try {
            await recorder.stageApproved!({
              runId: request.operation.operationId,
              assertCurrent: guard,
              assertAdmittedCurrent: assertCallerCurrent,
              turnIssuerAdmission: captureGatewayTurnIssuerAdmission({
                ...binding,
                runId: request.operation.operationId,
              }),
              goalRecoveryAdmission: {
                operation: request.operation,
                decision: request.decision,
                issuer,
              },
            });
            const committed = recorder.getGoalOperation?.();
            if (!committed) {
              throw new Error("The Goal recovery input was not durably accepted");
            }
            return committed.result;
          } finally {
            recorder.finishPendingInput?.("interrupted");
            await recorder.waitForPendingInputSettlement?.();
          }
        },
      },
      launchContinuation: async (continuation) => {
        assertCallerCurrent();
        const entry = continuation.entry;
        const runtime = context.recoveryRuntime;
        const observed =
          entry &&
          transitionMainSessionRecovery(entry, {
            kind: "inspect",
            sessionKey: request.sessionKey,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          });
        const view = observed?.kind === "observed" ? observed.view : undefined;
        if (!entry || !runtime || view?.status !== "recoverable") {
          return {
            status: "rejected",
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              "The accepted Goal continuation is awaiting recovery reconciliation.",
            ),
          };
        }
        const result = await resumeMainSession({
          ...continuation,
          entry,
          observation: view.observation,
          recoveryAttempt: view.nextAttempt,
          cfg: context.getRuntimeConfig(),
          gatewayRuntime: runtime,
          shouldContinue: () => {
            try {
              assertCallerCurrent();
              return true;
            } catch {
              return false;
            }
          },
        });
        return result === "started" || result === "settled"
          ? { status: "started", runId: continuation.idempotencyKey }
          : {
              status: "rejected",
              error: errorShape(
                ErrorCodes.UNAVAILABLE,
                "The accepted Goal continuation has not started; inspect its recovery status.",
              ),
            };
      },
    });
    if (!recovered.ok) {
      respond(false, undefined, recovered.error);
      return;
    }
    if (!recovered.goalOperation) {
      throw new Error("Goal recovery did not record its operation receipt");
    }
    await publishCommittedSessionGoalChange(context, {
      ...request,
      entry: recovered.successorEntry,
      actor: gatewayClientSessionCreator(client),
      summary: "goal resume",
    });
    if (recovered.continuation.status === "rejected") {
      respond(false, undefined, recovered.continuation.error);
      return;
    }
    respond(true, recovered.goalOperation, undefined, { runId: recovered.goalOperation.runId });
  } finally {
    captured.release();
  }
}
