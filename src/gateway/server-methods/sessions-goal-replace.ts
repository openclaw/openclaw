import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsGoalUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import {
  mutateSessionGoal,
  SessionGoalOperationError,
  type SessionGoalOperation,
} from "../../config/sessions/goals-operations.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../config/sessions/session-entry-current-check.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { SessionGoal } from "../../config/sessions/types.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  isRpcSourceExecuting,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureSessionControllerStop } from "../../sessions/session-controller.stop.js";
import {
  waitForChatAbortAcknowledgment,
  waitForChatAbortTerminalPersistence,
} from "../chat-abort-lifecycle-internal.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import type { resolveSessionSharingTargetAsync } from "../session-sharing.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { isDirectChatGoalSession } from "./chat-send-goal-admission.js";
import { handleSessionGoalResumeChat } from "./chat-send-handler.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Replacement = Extract<SessionsGoalUpdateParams, { action: "replace" }>;
type Target = NonNullable<Awaited<ReturnType<typeof resolveSessionSharingTargetAsync>>>;

/** One confirmed decision; ordinary Goal receipts own each completed durable stage. */
export async function replaceExecutingSessionGoal(params: {
  options: GatewayRequestHandlerOptions;
  request: Replacement;
  target: Target;
  source: SessionSourceAssertion;
  requestFingerprint: string;
}): Promise<void> {
  const { options, request, target, source, requestFingerprint } = params;
  const { context, respond } = options;
  const scope = {
    agentId: target.agentId,
    sessionKey: target.storeKey,
    storePath: target.storePath,
    expectedSessionId: request.sessionId,
  };
  const identity = { goalId: request.goalId, issuedAtMs: request.issuedAtMs, requestFingerprint };
  const stop: SessionGoalOperation & { action: "replace" } = {
    ...identity,
    operationId: requestFingerprint + ":interrupt",
    action: "replace",
    expectedRunId: request.expectedRunId,
  };
  const pause: SessionGoalOperation & { action: "pause" } = {
    ...identity,
    operationId: requestFingerprint + ":pause",
    action: "pause",
  };
  const edit: SessionGoalOperation & { action: "edit" } = {
    ...identity,
    operationId: requestFingerprint + ":edit",
    action: "edit",
    objective: request.objective,
  };
  const resume: SessionGoalOperation & { action: "resume" } = {
    ...identity,
    operationId: request.operationId,
    action: "resume",
    preserveBudget: true,
  };
  const lookup = async (operation: SessionGoalOperation) => {
    source();
    const receipt = await lookupSessionGoalOperation({ ...scope, operation });
    source();
    return receipt;
  };
  let stage = "interrupt";
  let interruptionWarning: string | undefined;
  let resumeGuard:
    | Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>
    | undefined;
  const changed = (message: string): never => {
    throw new SessionGoalOperationError("goal-rebound", message);
  };
  const readGoal = async (expected?: SessionGoal) => {
    source();
    const read = await captureSessionEntryCurrentCheckAsyncInternal({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: target.storeKey,
      fields: ["goal", "lifecycleRunId", "lastRunId"],
      errorMessage: "Goal or turn changed during replacement; review its current state.",
    });
    try {
      source();
      const entry = read.entry;
      if (
        entry?.sessionId !== request.sessionId ||
        (entry.lifecycleRunId ?? entry.lastRunId) !== request.expectedRunId ||
        entry.goal?.id !== request.goalId ||
        entry.goal.status === "complete"
      ) {
        changed(
          "The confirmed goal or turn changed. No newer turn will be interrupted or resumed.",
        );
      }
      if (expected && !isDeepStrictEqual(entry?.goal, expected)) {
        changed(
          "Goal controls changed after a replacement stage; review the current goal before continuing.",
        );
      }
      return read;
    } catch (error) {
      read.release();
      throw error;
    }
  };
  const resumeChat = async (replacementSource?: { runId: string; goal: SessionGoal }) => {
    return await handleSessionGoalResumeChat(
      {
        ...options,
        sessionMutationAuthorization: { assertCurrent: source, assertTargetCurrent: source },
        params: {
          sessionKey: target.canonicalKey,
          agentId: target.agentId,
          sessionId: request.sessionId,
          message: "Continue pursuing the current goal.",
          idempotencyKey: request.operationId,
          deliver: false,
        },
        respond: (ok, payload, error, meta) => {
          if (ok && payload && typeof payload === "object") {
            respond(true, { ...payload, action: "replace" }, undefined, meta);
          } else {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "Goal replacement stopped at resume. " +
                  (error?.message ??
                    "Check the saved request before retrying; continuation admission was not confirmed."),
                { details: { stage: "resume" } },
              ),
            );
          }
        },
      },
      { ...resume, ...(replacementSource ? { replacementSource } : {}) },
    );
  };
  try {
    // Use normal same-ID Resume recovery even when the accepted receipt already exists.
    if (await lookup(resume)) {
      await resumeChat();
      return;
    }
    await runSessionMutation({
      target: captureSessionTarget({
        storeScope: target.storePath,
        sessionKey: target.storeKey,
        agentId: target.agentId,
        incarnation: request.sessionId,
      }),
      requiredSessionId: request.sessionId,
      policy: "allow-live",
      assertCurrent: source,
      // The active mutation passively fences admission. A session-wide closure would
      // cancel unrelated queued effects even when this confirmed decision is stale.
      run: async () => {
        // A concurrent identical request may have completed while this one waited for the owner.
        if (await lookup(resume)) {
          return;
        }
        const paused = await lookup(pause);
        const edited = await lookup(edit);
        let stoppedReceipt = await lookup(stop);
        if (!paused) {
          if (!stoppedReceipt) {
            const before = await readGoal();
            try {
              const entry = before.entry!;
              if (
                entry.lifecycleRunId !== request.expectedRunId ||
                entry.goal?.status !== "active" ||
                entry.goal.updatedAt !== request.expectedGoalUpdatedAt ||
                !isDirectChatGoalSession({
                  entry,
                  acpMeta: entry.acp ?? null,
                  sessionKey: target.canonicalKey,
                  requestedSessionId: request.sessionId,
                })
              ) {
                changed(
                  "The original active goal changed or this runtime cannot replace it. Review it before retrying.",
                );
              }
              const active = getRpcSourceForGateway(
                request.expectedRunId,
                context.resolveGatewayContext,
              );
              const workerControl = getWorkerInferenceSessionControl(
                context.workerEnvironmentService,
              );
              const worker = workerControl?.resolveSessionTargetForRunId(request.expectedRunId);
              const workerCancellation = worker
                ? workerControl!.captureSessionCancellation(
                    request.sessionId,
                    request.expectedRunId,
                  )
                : undefined;
              const activeIdentity = active && getRpcSourceIdentity(active);
              if (
                !(
                  active &&
                  isRpcSourceExecuting(active) &&
                  activeIdentity?.sessionId === request.sessionId &&
                  activeIdentity.agentId === target.agentId &&
                  activeIdentity.sessionKey === target.canonicalKey
                ) &&
                !(
                  workerCancellation?.executing &&
                  worker?.sessionId === request.sessionId &&
                  worker.agentId === target.agentId &&
                  worker.sessionKey === target.canonicalKey
                )
              ) {
                changed(
                  "The confirmed turn is no longer executing. Review the current goal; replacement did not edit or resume it.",
                );
              }
              const settlement = active
                ? captureSessionControllerStop({ inputs: [active.input] }).settled
                : undefined;
              const abortParams = {
                sessionKey: target.canonicalKey,
                agentId: target.agentId,
                runId: request.expectedRunId,
              };
              const authorization = await resolveSessionMutationAuthorizationAsync({
                client: options.client,
                method: "chat.abort",
                requestParams: abortParams,
                context,
              });
              if (authorization.error) {
                throw new Error(authorization.error.message);
              }
              let interrupted = false;
              const assertInterrupt = () => {
                source();
                authorization.authorization?.assertCurrent();
                if (!interrupted) {
                  before.source();
                  if (
                    active &&
                    (!isRpcSourceExecuting(active) ||
                      getRpcSourceForGateway(
                        request.expectedRunId,
                        context.resolveGatewayContext,
                      ) !== active)
                  ) {
                    changed("The confirmed turn finished or changed before interruption.");
                  }
                }
              };
              let abortFailure: Error | undefined;
              try {
                await handleChatAbortRequestWithLifecycle(
                  bindGatewayRequestHandlerMutationAuthority(
                    options,
                    {
                      ...options,
                      params: abortParams,
                      sessionMutationAuthorization: authorization.authorization,
                      sessionMutationCommitGuard: assertInterrupt,
                      respond: (ok, payload, error) => {
                        if (isRecord(payload) && typeof payload.warning === "string") {
                          interruptionWarning = payload.warning;
                        }
                        if (!ok) {
                          abortFailure = new Error(
                            error?.message ?? "Interruption was not confirmed.",
                          );
                        }
                      },
                    },
                    undefined,
                  ),
                  {
                    onExactRunAborted: (runId) => {
                      if (runId === request.expectedRunId) {
                        interrupted = true;
                      }
                    },
                  },
                );
                if (abortFailure) {
                  throw abortFailure;
                }
                if (!interrupted) {
                  changed(
                    "Interruption was not accepted for the original turn; review the goal before retrying.",
                  );
                }
                if (workerCancellation) {
                  await waitForChatAbortAcknowledgment(workerCancellation.settled);
                }
                if (settlement) {
                  await waitForChatAbortAcknowledgment(settlement);
                }
                if (active) {
                  await waitForChatAbortTerminalPersistence(active);
                }
                source();
                // Stop permits partial-history warnings; replacement must not silently
                // edit/resume after losing interrupted output. Keep its original recovery ID.
                if (interruptionWarning) {
                  throw new Error(interruptionWarning);
                }
              } finally {
                authorization.authorization?.release?.();
              }
            } finally {
              before.release();
            }
            // Record only a completed exact interruption. An uncertain stop has no receipt and
            // cannot be replayed as permission to interrupt another run or resume anything.
            const settled = await readGoal();
            try {
              stoppedReceipt = (
                await mutateSessionGoal({
                  ...scope,
                  operation: stop,
                  assertCurrent: composeSessionSourceAssertion([source, settled.source]),
                })
              ).result;
            } finally {
              settled.release();
            }
          }
          stage = "pause";
          const stopped = await readGoal(stoppedReceipt?.goal);
          try {
            if (
              stopped.entry?.goal?.objective !== target.entry.goal?.objective ||
              !["active", "paused"].includes(stopped.entry?.goal?.status ?? "")
            ) {
              changed(
                "The goal changed while the interrupted turn settled; replacement will not overwrite it.",
              );
            }
            const committed = await mutateSessionGoal({
              ...scope,
              operation: pause,
              assertCurrent: composeSessionSourceAssertion([source, stopped.source]),
            });
            if (committed.sessionEntry) {
              await publishCommittedSessionGoalChange(context, {
                sessionKey: target.canonicalKey,
                agentId: target.agentId,
                entry: committed.sessionEntry,
                actor: gatewayClientSessionCreator(options.client),
                summary: "goal pause",
              });
            }
          } finally {
            stopped.release();
          }
        }
        stage = "edit";
        const pauseReceipt = paused ?? (await lookup(pause));
        if (!pauseReceipt?.goal) {
          throw new Error("The replacement pause receipt is unavailable.");
        }
        if (!edited) {
          const current = await readGoal(pauseReceipt.goal);
          try {
            const committed = await mutateSessionGoal({
              ...scope,
              operation: edit,
              assertCurrent: composeSessionSourceAssertion([source, current.source]),
            });
            if (committed.sessionEntry) {
              await publishCommittedSessionGoalChange(context, {
                sessionKey: target.canonicalKey,
                agentId: target.agentId,
                entry: committed.sessionEntry,
                actor: gatewayClientSessionCreator(options.client),
                summary: "goal edit",
              });
            }
          } finally {
            current.release();
          }
        }
        stage = "resume";
        const editReceipt = edited ?? (await lookup(edit));
        if (!editReceipt?.goal) {
          throw new Error("The replacement edit receipt is unavailable.");
        }
        resumeGuard = await readGoal(editReceipt.goal);
      },
    });
    const completed = await lookup(resume);
    if (completed) {
      await resumeChat();
      return;
    }
    if (!resumeGuard) {
      throw new Error("The replacement's resume target is unavailable.");
    }
    // This preimage belongs in the atomic writer, not the accepted input authority:
    // its own successful Resume changes both the goal and lifecycleRunId.
    const replacementSource = { runId: request.expectedRunId, goal: resumeGuard.entry!.goal! };
    resumeGuard.release();
    resumeGuard = undefined;
    await resumeChat(replacementSource);
  } catch (error) {
    if (error instanceof SessionGoalOperationError) {
      throw new SessionGoalOperationError(
        error.code,
        "Goal replacement stopped at " + stage + ": " + error.message,
      );
    }
    context.logGateway.warn("Goal replacement stopped at " + stage);
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Goal replacement stopped at " +
          stage +
          ". " +
          (interruptionWarning ? interruptionWarning + " " : "") +
          "The objective was not resumed. Review the current goal and check the saved request before continuing.",
        { details: { stage } },
      ),
    );
  } finally {
    resumeGuard?.release();
  }
}
