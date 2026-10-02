import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_CLOSING_UNAVAILABLE_REASON,
  GATEWAY_RESTART_UNAVAILABLE_REASON,
  GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
  GATEWAY_SUSPEND_UNAVAILABLE_REASON,
} from "../../packages/gateway-protocol/src/restart-unavailable.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { canSelectQuestion } from "./question-access.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

export function runGatewayPendingWorkContinuation<T>(params: {
  method: string;
  client: GatewayRequestOptions["client"];
  requestParams: unknown;
  context: GatewayRequestContext;
  admission?: "continuation";
  run: () => Promise<T>;
}): Promise<T> | null {
  if (!isRecord(params.requestParams)) {
    return null;
  }
  const request = params.requestParams;
  if (params.client?.connect.role === "node") {
    if (
      params.admission !== "continuation" &&
      getGatewaySuspendAdmissionPhase() !== "draining" &&
      !isGatewayRestartDraining()
    ) {
      return null;
    }
    const invokeId =
      params.method === "node.invoke.progress"
        ? request.invokeId
        : params.method === "node.invoke.result"
          ? request.id
          : undefined;
    if (typeof invokeId !== "string" || typeof request.nodeId !== "string") {
      return null;
    }
    return params.context.nodeRegistry.runPendingInvokeContinuation({
      invokeId,
      nodeId: request.nodeId,
      connId: params.client.connId,
      run: params.run,
    });
  }
  if (
    params.admission === "continuation" ||
    (getGatewaySuspendAdmissionPhase() !== "draining" && !isGatewayRestartDraining()) ||
    params.client?.connect.role !== "operator" ||
    typeof request.id !== "string"
  ) {
    return null;
  }
  if (params.method === "question.resolve" || params.method === "question.get") {
    const questionManager = params.context.questionManager;
    return questionManager && canSelectQuestion(questionManager, request.id, params.client)
      ? questionManager.runPendingContinuation(request.id, params.run)
      : null;
  }
  const manager =
    params.method === "exec.approval.resolve"
      ? params.context.execApprovalManager
      : params.method === "plugin.approval.resolve"
        ? params.context.pluginApprovalManager
        : params.method === "approval.resolve"
          ? request.kind === "exec"
            ? params.context.execApprovalManager
            : request.kind === "plugin"
              ? params.context.pluginApprovalManager
              : request.kind === "system-agent"
                ? params.context.systemAgentApprovalManager
                : undefined
          : undefined;
  return manager?.runPendingContinuation(request.id, params.run) ?? null;
}

export function workAdmissionUnavailableError(method: string) {
  const restartDraining = isGatewayRestartDraining();
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `${method} unavailable during gateway ${restartDraining ? "restart" : "suspension"}`,
    {
      retryable: true,
      retryAfterMs:
        !restartDraining && method === "agent.identity.get"
          ? GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS
          : 1_000,
      details: {
        method,
        reason: restartDraining
          ? GATEWAY_RESTART_UNAVAILABLE_REASON
          : GATEWAY_SUSPEND_UNAVAILABLE_REASON,
        phase: getGatewaySuspendAdmissionPhase(),
      },
    },
  );
}

/** Retryable refusal for new work arriving at a generation that already began closing. */
export function gatewayClosingUnavailableError(method: string) {
  return errorShape(ErrorCodes.UNAVAILABLE, `${method} unavailable during gateway shutdown`, {
    retryable: true,
    retryAfterMs: 1_000,
    details: {
      method,
      reason: GATEWAY_CLOSING_UNAVAILABLE_REASON,
      phase: getGatewaySuspendAdmissionPhase(),
    },
  });
}

/** Cancels passive waiters without abandoning their owner's admitted writes. */
export async function runWithGatewayObservationScope<T>(
  run: () => T | Promise<T>,
  requestSignals: (AbortSignal | undefined)[],
  cancelled: () => T | Promise<T>,
): Promise<T> {
  const work = new AsyncWorkScope();
  const signal = AbortSignal.any(
    [getGatewayRestartDrainSignal(), getAsyncWorkSignal(), ...requestSignals].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  const close = () => work.beginClose(signal.reason);
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
  }
  try {
    work.signal.throwIfAborted();
    const result = await work.track(run);
    work.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (!work.signal.aborted) {
      throw error;
    }
    return await cancelled();
  } finally {
    signal.removeEventListener("abort", close);
    await work.drain();
  }
}
