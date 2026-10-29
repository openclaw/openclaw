import { randomUUID } from "node:crypto";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../../auto-reply/reply/session-event-handoff.js";
import { prepareSessionEventTargetForHost } from "../../auto-reply/reply/session-event-target.js";
import {
  captureOperatorToolGatewayContinuationContext,
  captureOperatorToolGatewayRequestContinuationContext,
} from "../../gateway/server-plugin-in-process-dispatch.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  execRequestAbortSignal,
  withExecRequestOwners,
  withExecRequestTurn,
  type ExecRequestOwner,
} from "../../infra/exec-request-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOutsidePluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { registerReplyOperationSuccessorBarrier } from "../../sessions/session-controller.barriers.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import {
  assertSessionControllerOperation,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.identity.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { jsonResult, ToolInputError } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { SessionsYieldCallback } from "./sessions-yield-tool.js";

const log = createSubsystemLogger("agent/tool-handoff");
const pending = new WeakSet<object>();

type HandoffScope = { assertCurrent: () => void; signal: AbortSignal };
type HandoffWork =
  | { run: (scope: HandoffScope) => Promise<Record<string, unknown>>; request?: never }
  | { request: { method: "plugins.reload"; params: Record<string, unknown> }; run?: never };

/** Retain invocation authority while the reply owner yields to an existing Gateway operation. */
export async function handoffSessionTool(
  params: HandoffWork & {
    name: string;
    fenceSuccessors?: true;
    sessionId?: string;
    runId?: string;
    operation?: ReplyOperation;
    requestOwners?: readonly ExecRequestOwner[];
    onYield?: SessionsYieldCallback;
    signal?: AbortSignal;
    formatResult: (payload: Record<string, unknown>) => string;
  },
) {
  if (getAgentToolExecutionContext()?.hasUnobservedAsyncToolResults) {
    return jsonResult({
      status: "deferred",
      message: `Read earlier async results before handing off ${params.name}.`,
    });
  }
  const caller = getGatewayToolCallerIdentity();
  const operation = params.operation;
  if (
    !caller ||
    !params.onYield ||
    !params.sessionId ||
    !operation?.hasOwnedSessionId(params.sessionId) ||
    !isCurrentSessionControllerOperation(operation) ||
    operation.result
  ) {
    throw new ToolInputError(
      `${params.name} requires an active Gateway conversation with turn yielding.`,
    );
  }
  if (pending.has(operation)) {
    throw new ToolInputError(`This turn already handed off a ${params.name.toLowerCase()}.`);
  }
  pending.add(operation);
  const handoffSettled = createDeferredCore();
  let continuation:
    | Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
    | Awaited<ReturnType<typeof captureOperatorToolGatewayRequestContinuationContext>> = undefined;
  let runDeferred: ((scope: HandoffScope) => Promise<Record<string, unknown>>) | undefined;
  let enqueueDeferred:
    | ((
        ...args: Parameters<typeof enqueueSessionEventForHost>
      ) =>
        | ReturnType<typeof enqueueSessionEventForHost>
        | Promise<ReturnType<typeof enqueueSessionEventForHost>>)
    | undefined;
  try {
    const gatewayTarget = { agentId: caller.agentId, sessionKey: caller.sessionKey };
    if (params.request) {
      const captured = await captureOperatorToolGatewayRequestContinuationContext(
        gatewayTarget,
        params.request,
      );
      continuation = captured;
      runDeferred = captured ? (scope) => captured.dispatch(scope) : undefined;
      enqueueDeferred = captured
        ? (text, options) => captured.enqueueSessionEvent(text, options)
        : undefined;
    } else {
      const captured = await captureOperatorToolGatewayContinuationContext(gatewayTarget);
      const run = params.run;
      continuation = captured;
      runDeferred = captured ? (scope) => captured.run(() => run(scope)) : undefined;
      enqueueDeferred = captured
        ? (text, options) =>
            captured.run(() =>
              runOutsidePluginRuntimeRegistryScope(() => enqueueSessionEventForHost(text, options)),
            )
        : undefined;
    }
    if (!continuation || !runDeferred || !enqueueDeferred) {
      throw new ToolInputError(`${params.name} requires its admitted Gateway.`);
    }
    const target = await captureSessionEventTargetForHost(caller.agentId, caller.sessionKey, {
      operatorAuthority: continuation.operatorAuthority,
    });
    const storePath = target.storePath;
    if (target.sessionId !== params.sessionId || !storePath) {
      throw new ToolInputError("The requesting session changed before handoff.");
    }
    continuation.assertCurrent();
    assertSessionControllerOperation(operation);
    params.signal?.throwIfAborted();
    if (params.fenceSuccessors) {
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: params.sessionId,
        sessionKeys: [caller.sessionKey],
        start: () => handoffSettled.promise,
      });
    }
    await params.onYield(
      `${params.name} handed off; resume with its result in this same conversation.`,
    );
    const retained = continuation;
    const deferred = runDeferred;
    const enqueue = enqueueDeferred;
    const contextKey = "tool-handoff:" + randomUUID();
    let result: Record<string, unknown> | undefined;
    // Start from the context-free root: the yielded turn's caller identity, retired receipts and
    // aborted run signal must reach neither this work nor the resumed turn's tools. Every input is
    // captured above; no CLI child or prepared-generation borrow belongs to this work.
    // A process crash before delivery may lose this in-memory handoff; retry explicitly.
    void runInDetachedAsyncContext(() =>
      runWithGatewayDetachedWorkContinuation(
        () =>
          withExecRequestTurn(
            {
              identity: {
                runId: params.runId,
                sessionId: params.sessionId,
                sessionKey: caller.sessionKey,
                agentId: caller.agentId,
              },
              owners: params.requestOwners,
            },
            async () => {
              const signal =
                execRequestAbortSignal(params.requestOwners, operation.abortSignal) ??
                operation.abortSignal;
              await operation.ownerSettlement;
              if (signal.aborted) {
                return;
              }
              try {
                const destination = await prepareSessionEventTargetForHost(target);
                try {
                  result = await deferred({
                    assertCurrent: destination.assertCurrent,
                    signal: AbortSignal.any([retained.signal, signal]),
                  });
                } finally {
                  destination.release();
                }
              } catch (error) {
                result = {
                  ok: false,
                  error: formatErrorMessage(error),
                  ...(error instanceof GatewayClientRequestError
                    ? { code: error.gatewayCode, details: error.details }
                    : {}),
                };
              }
              // A resumed turn must never wait behind its own source transition.
              handoffSettled.resolve(undefined);
              if (params.fenceSuccessors) {
                const released = await waitForReplyRunSuccessorAdmission(caller.sessionKey, null, {
                  signal: AbortSignal.any([retained.signal, signal]),
                  target: captureSessionTarget({
                    storeScope: storePath,
                    sessionKey: caller.sessionKey,
                    agentId: caller.agentId,
                    incarnation: params.sessionId,
                  }),
                });
                if (!released.settled) {
                  if (signal.aborted) {
                    return;
                  }
                  throw new Error("the conversation did not become ready to resume");
                }
              }
              if (signal.aborted) {
                return;
              }
              const eventText =
                params.name +
                " result: " +
                params.formatResult(result) +
                "\nContinue the original task in this conversation. Do not repeat a completed operation.";
              // Retain the admitted Gateway, but let resume select the replacement plugin registry.
              const receipt = await enqueue(
                eventText,
                withExecRequestOwners(
                  {
                    agentId: caller.agentId,
                    sessionKey: caller.sessionKey,
                    source: "tool_handoff",
                    // A yielded subagent task resumes as itself only from its own run's handoff.
                    sourceRunId: params.runId,
                    contextKey,
                    expectedTarget: target,
                    assertAcceptanceCurrent: retained.assertCurrent,
                    abortSignal: signal,
                  },
                  params.requestOwners,
                ),
              );
              const accepted = await receipt.accepted;
              if (!accepted.ok) {
                throw new Error(accepted.error);
              }
              const outcome = await receipt.settled;
              // Once execution starts, the ordinary turn owns its failure.
              // It is no longer an undelivered tool result.
              if (outcome.status === "failed" && !outcome.executionStarted) {
                throw new Error(outcome.error ?? "Tool result resume failed");
              }
            },
          ),
        "agent:tool-handoff",
      )
        .catch(async (error: unknown) => {
          const reason = formatErrorMessage(error);
          log.error(params.name + " handoff failed: " + reason);
          // An undelivered result must not leave the conversation silent.
          const { appendAssistantMessageToSessionTranscript } =
            await import("../../config/sessions/transcript.js");
          const notice = await appendAssistantMessageToSessionTranscript({
            agentId: caller.agentId,
            sessionKey: caller.sessionKey,
            storePath,
            // The captured conversation only: a same-ID reset rotates the lifecycle revision.
            expectedSessionId: params.sessionId,
            expectedLifecycleRevision: target.lifecycleRevision ?? null,
            idempotencyKey: contextKey + ":undelivered",
            text:
              `${params.name} could not continue this conversation automatically: ${reason}. ` +
              (result
                ? `Its result: ${params.formatResult(result)}. Send a message to continue from it; do not repeat it.`
                : "Send a message to retry."),
          }).catch((noticeError: unknown) => ({
            ok: false,
            reason: formatErrorMessage(noticeError),
          }));
          if (!notice.ok) {
            log.error(params.name + " handoff notice failed: " + notice.reason);
          }
        })
        .finally(() => {
          handoffSettled.resolve(undefined);
          retained.release();
        }),
    );
    // The shared async-result receipt is also the yield owner's continuation evidence.
    return jsonResult({
      status: "started",
      async: true,
      yielded: true,
      message: `${params.name} will run after turn cleanup; its result will resume this session.`,
    });
  } catch (error) {
    handoffSettled.resolve(undefined);
    pending.delete(operation);
    continuation?.release();
    throw error;
  }
}
