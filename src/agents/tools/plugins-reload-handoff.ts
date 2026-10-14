import { randomUUID } from "node:crypto";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { resolveActiveReplyOperationForSessionId } from "../../auto-reply/reply/reply-run-registry.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../../auto-reply/reply/session-event-handoff.js";
import { prepareSessionEventTargetForHost } from "../../auto-reply/reply/session-event-target.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-dispatch.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  execRequestAbortSignal,
  withExecRequestOwners,
  withExecRequestTurn,
  type ExecRequestOwner,
} from "../../infra/exec-request-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import { jsonResult, ToolInputError } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import type { SessionsYieldCallback } from "./sessions-yield-tool.js";

const log = createSubsystemLogger("plugins/reload-handoff");
const pending = new WeakSet<object>();

/** The reply owner releases the turn; the ordinary reload owner still drains physical leases. */
export async function handoffPluginReload(params: {
  sessionId?: string;
  runId?: string;
  requestOwners?: readonly ExecRequestOwner[];
  onYield?: SessionsYieldCallback;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  formatResult: (payload: Record<string, unknown>) => string;
}) {
  if (getAgentToolExecutionContext()?.hasUnobservedAsyncToolResults) {
    return jsonResult({
      status: "deferred",
      message: "Read earlier async results before handing off the reload.",
    });
  }
  const caller = getGatewayToolCallerIdentity();
  const operation = params.sessionId
    ? resolveActiveReplyOperationForSessionId(params.sessionId)
    : undefined;
  if (!caller || !params.onYield || !operation?.ownerSettlement) {
    throw new ToolInputError(
      "reloadAndResume requires an active Gateway conversation with turn yielding.",
    );
  }
  if (pending.has(operation)) {
    throw new ToolInputError("This turn already handed off a plugin reload.");
  }
  pending.add(operation);
  let continuation: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>> =
    undefined;
  try {
    continuation = await captureOperatorToolGatewayContinuationContext({
      agentId: caller.agentId,
      sessionKey: caller.sessionKey,
    });
    if (!continuation) {
      throw new ToolInputError("reloadAndResume requires its admitted Gateway.");
    }
    const target = await captureSessionEventTargetForHost(caller.agentId, caller.sessionKey);
    if (target.sessionId !== params.sessionId) {
      throw new ToolInputError("The reload requester session changed before handoff.");
    }
    continuation.assertCurrent();
    operation.abortSignal.throwIfAborted();
    params.signal?.throwIfAborted();
    await params.onYield(
      "Plugin reload handed off; resume with its result in this same conversation.",
    );
    const retained = continuation;
    // No CLI child or prepared-generation borrow belongs to this work.
    // A process crash before delivery may lose this in-memory handoff; retry explicitly.
    void runOutsidePreparedModelRuntimePluginGenerationScope(() =>
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
              try {
                await operation.ownerSettlement;
                if (signal.aborted) {
                  return;
                }
                let result: Record<string, unknown>;
                try {
                  const destination = await prepareSessionEventTargetForHost(target);
                  try {
                    result = await retained.run(() =>
                      callAgentToolGatewayRequest({
                        method: "plugins.reload",
                        params: params.request,
                        sessionMutationCommitGuard: destination.assertCurrent,
                        signal: AbortSignal.any([retained.signal, signal]),
                        timeoutMs: null,
                      }),
                    );
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
                if (signal.aborted) {
                  return;
                }
                const receipt = enqueueSessionEventForHost(
                  "Plugin reload result: " +
                    params.formatResult(result) +
                    "\nContinue the original task in this conversation. Do not repeat a completed reload.",
                  withExecRequestOwners(
                    {
                      agentId: caller.agentId,
                      sessionKey: caller.sessionKey,
                      source: "plugin",
                      contextKey: "plugin-reload:" + randomUUID(),
                      expectedTarget: target,
                      assertCurrent: retained.assertCurrent,
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
                if (outcome.status === "failed") {
                  throw new Error(outcome.error ?? "Plugin reload resume failed");
                }
              } finally {
                retained.release();
              }
            },
          ),
        "plugins:reload-handoff",
      ),
    )
      .catch((error: unknown) =>
        log.error("Plugin reload handoff failed: " + formatErrorMessage(error)),
      )
      .finally(() => retained.release());
    // The shared async-result receipt is also the yield owner's continuation evidence.
    return jsonResult({
      status: "started",
      async: true,
      yielded: true,
      message: "Reload will run after turn cleanup; its result will resume this session.",
    });
  } catch (error) {
    pending.delete(operation);
    continuation?.release();
    throw error;
  }
}
