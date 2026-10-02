import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import {
  isPrivateNodeInvokeCommand,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../infra/node-commands.js";
import { awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { buildNodeInvokeRequest, serializeNodeEvent } from "./node-invoke-request.js";
import type { NodeInvokeParams, NodeInvokeResult } from "./node-invoke.types.js";
import type { NodeInvokeStreamController, PendingInvoke } from "./node-registry.invoke-stream.js";
import {
  normalizeSystemRunInvokeParams,
  resolvePendingSystemRunEvent,
} from "./node-registry.system-run.js";
import type { NodeRunnerRegistrySession } from "./node-runner-inventory-runtime.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";

type PairingBoundNodeSession = NodeRunnerRegistrySession & { pairingIdentity: string };
type PairingLeaseResolution =
  | { status: "current"; session: PairingBoundNodeSession }
  | { status: "stale"; presenceInvalidated: boolean }
  | { status: "unavailable" };

export type NodeRegistryInvokeState = {
  context: {
    getNode: (nodeId: string) => PairingBoundNodeSession | undefined;
    isCommandAllowed: (nodeId: string, command: string) => boolean;
    hasCurrentPairingStateResolver: boolean;
    preparePairingLease: (node: PairingBoundNodeSession) => () => Promise<PairingLeaseResolution>;
    pendingInvokes: Map<string, PendingInvoke>;
    invokeStreams: NodeInvokeStreamController;
    sendEventToSession: (
      node: NodeRunnerRegistrySession,
      event: string,
      payload: unknown,
    ) => boolean;
    rememberAuthorizedSystemRunEvent: (event: {
      nodeId: string;
      connId: string;
      runId: string;
      sessionKey?: string;
      timeoutMs?: number | null;
    }) => void;
  };
  generationBoundInvokes: WeakMap<
    PendingInvoke,
    { expectedGeneration: string; controller: AbortController }
  >;
};

export async function invokeNodeRegistryCore(
  state: NodeRegistryInvokeState,
  params: NodeInvokeParams,
  allowPrivateCommand: boolean,
  isCompletionAuthorized?: () => boolean,
): Promise<NodeInvokeResult> {
  let timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 30_000, 0);
  // Explicit budgets include pairing and serialization; omitted budgets retain
  // the post-dispatch default, and zero keeps long-lived invokes unbounded.
  const deadlineAtMs =
    params.deadlineAtMs ??
    (Number.isFinite(params.timeoutMs) && timeoutMs > 0
      ? performance.now() + timeoutMs
      : undefined);
  if (isPrivateNodeInvokeCommand(params.command) && !allowPrivateCommand) {
    return {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "private node command is not invocable" },
    };
  }
  if (params.signal?.aborted) {
    return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
  }
  const initialNode = state.context.getNode(params.nodeId);
  if (!initialNode) {
    return { ok: false, error: { code: "NOT_CONNECTED", message: "node not connected" } };
  }
  if (initialNode.client.invalidated === true) {
    return {
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
    };
  }
  const expectedPairingGeneration =
    params.expectedPairingGeneration ?? initialNode.pairingGeneration;
  if (state.context.hasCurrentPairingStateResolver && !expectedPairingGeneration) {
    return {
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing generation unavailable" },
    };
  }
  if (expectedPairingGeneration && initialNode.pairingGeneration !== expectedPairingGeneration) {
    return {
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
    };
  }
  if (params.expectedConnId && initialNode.connId !== params.expectedConnId) {
    return {
      ok: false,
      error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
    };
  }
  // A live session may be promoted in place while this request waits for admission.
  const resolvePairingLease = state.context.hasCurrentPairingStateResolver
    ? state.context.preparePairingLease(initialNode)
    : undefined;
  type InvocationStart = NodeInvokeResult | { pending: Promise<NodeInvokeResult> };
  let completed: Result<InvocationStart, unknown> | undefined;
  let dispatchedResult: Promise<NodeInvokeResult> | undefined;
  const start = async (): Promise<InvocationStart> => {
    let node = initialNode;
    if (resolvePairingLease) {
      if (params.signal?.aborted) {
        return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
      }
      if (deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) {
        return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
      }
      let resolution: PairingLeaseResolution;
      try {
        resolution = await resolvePairingLease();
      } catch (error) {
        if (params.signal?.aborted) {
          return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
        }
        throw error;
      }
      if (params.signal?.aborted) {
        return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
      }
      if (deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) {
        return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
      }
      if (resolution.status === "unavailable") {
        return {
          ok: false,
          error: { code: "UNAVAILABLE", message: "node pairing state unavailable before dispatch" },
        };
      }
      if (resolution.status !== "current") {
        return {
          ok: false,
          error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
        };
      }
      node = resolution.session;
      if (params.expectedConnId && node.connId !== params.expectedConnId) {
        return {
          ok: false,
          error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
        };
      }
    }
    const requestId = randomUUID();
    const invokeParams = normalizeSystemRunInvokeParams({
      command: params.command,
      params: params.params,
    });
    const payload = buildNodeInvokeRequest({
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      params: "params" in params ? invokeParams : undefined,
      timeoutMs,
      idempotencyKey: params.idempotencyKey,
      sessionKey: params.sessionKey,
    });
    if (
      params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND &&
      Buffer.byteLength(serializeNodeEvent("node.invoke.request", payload), "utf8") >
        MAX_PAYLOAD_BYTES
    ) {
      return {
        ok: false,
        error: { code: "INVALID_REQUEST", message: "worker launch exceeds the node payload limit" },
      };
    }
    const systemRunEvent = resolvePendingSystemRunEvent({
      command: params.command,
      params: invokeParams,
    });
    // Serialization can consume the budget or close caller-owned authority.
    // Revalidate both before arming pending state and handing off to transport.
    if (params.signal?.aborted) {
      return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
    }
    if (params.isDispatchAuthorized?.() === false) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_AUTHORITY_CLOSED",
          message: "runtime authority closed before node dispatch",
        },
      };
    }
    if (!state.context.isCommandAllowed(params.nodeId, params.command)) {
      return {
        ok: false,
        error: { code: "POLICY_CHANGED", message: "node command is no longer allowed" },
      };
    }
    if (deadlineAtMs !== undefined) {
      timeoutMs = Math.max(0, deadlineAtMs - performance.now());
      if (timeoutMs === 0) {
        return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
      }
      // Keep the precise monotonic budget for Gateway timers, but satisfy the integer
      // node-event contract without turning a sub-millisecond budget into "unbounded".
      payload.timeoutMs = Math.ceil(timeoutMs);
    }
    const result = new Promise<NodeInvokeResult>((resolve, reject) => {
      const pending: PendingInvoke = {
        nodeId: params.nodeId,
        connId: node.connId,
        command: params.command,
        systemRunEvent,
        resolve,
        reject,
        nextProgressSeq: 0,
        progressChunks: new Map(),
        nextInputSeq: 0,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
        // Lifecycle cleanup retains its exact owner through reply settlement.
        ...(isCompletionAuthorized ? { isCompletionAuthorized } : {}),
      };
      const generationController = params.expectedPairingGeneration
        ? new AbortController()
        : undefined;
      if (params.expectedPairingGeneration && generationController) {
        state.generationBoundInvokes.set(pending, {
          expectedGeneration: params.expectedPairingGeneration,
          controller: generationController,
        });
      }
      const signal = generationController
        ? params.signal
          ? AbortSignal.any([params.signal, generationController.signal])
          : generationController.signal
        : params.signal;
      const idleTimeoutMs = resolveTimerTimeoutMs(params.idleTimeoutMs, 0, 0);
      state.context.invokeStreams.armPending({
        requestId,
        pending,
        timeoutMs,
        deadlineAtMs,
        idleTimeoutMs,
        ...(signal ? { signal } : {}),
      });
    });
    const pendingAtDispatch = state.context.pendingInvokes.get(requestId);
    if (!pendingAtDispatch) {
      return { pending: result };
    }
    const dispatchDeadlineAtMs = pendingAtDispatch.deadlineAtMs;
    const ok = state.context.sendEventToSession(node, "node.invoke.request", payload);
    if (!ok) {
      const pending = state.context.pendingInvokes.get(requestId);
      if (pending) {
        state.context.invokeStreams.clearTimers(pending);
        state.context.pendingInvokes.delete(requestId);
        pending.resolve({
          ok: false,
          error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
        });
      }
      return { pending: result };
    }
    dispatchedResult = result;
    if (systemRunEvent) {
      state.context.rememberAuthorizedSystemRunEvent({
        nodeId: params.nodeId,
        connId: node.connId,
        ...systemRunEvent,
      });
    }
    params.onDispatchReady?.(requestId, dispatchDeadlineAtMs);
    return { pending: result };
  };
  const admit = async () => {
    try {
      completed = { ok: true, value: await start() };
    } catch (error) {
      completed = { ok: false, error };
    }
  };
  // Admission joins the real read through synchronous handoff. Caller expiry
  // must not release its lock while borrowed pairing work is still running.
  try {
    if (state.context.hasCurrentPairingStateResolver) {
      await awaitWithinDeadline(
        () => racePromiseWithAbortSignal(withDevicePairingLock(admit), params.signal),
        deadlineAtMs,
        () => performance.now(),
      );
    } else {
      await admit();
    }
  } catch (error) {
    if (!params.signal?.aborted) {
      throw error;
    }
  }
  if (completed && !completed.ok) {
    throw completed.error;
  }
  // Creating a pending promise is not dispatch. A successful send keeps its
  // owned result even if a callback or caller observes the deadline afterward.
  if (dispatchedResult) {
    return await dispatchedResult;
  }
  if (completed?.ok) {
    return "pending" in completed.value ? await completed.value.pending : completed.value;
  }
  return params.signal?.aborted
    ? { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } }
    : { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
}
