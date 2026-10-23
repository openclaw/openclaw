import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  type RpcSourceRef,
} from "../../../sessions/session-controller.rpc-sources.js";
import type { SessionTarget } from "../../../sessions/session-controller.target.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { cleanupMaterializedSubagentAttachments } from "./subagent-attachments.js";
import { callSubagentGateway, type SubagentGatewayRequest } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
type GatewayCall = (options: SubagentGatewayRequest) => Promise<unknown>;
type AcceptedRunAbortParams = {
  childSessionKey: string;
  gatewayRunId: string;
  isCurrent?: () => boolean;
  callGateway?: GatewayCall;
  timeoutMs?: number;
};
type AcceptedRunTerminationResult = { status: "settled" } | { status: "failed"; error: unknown };

/** Binds rollback to the session this spawn created, independently of its operator's lifetime. */
export function bindSubagentSpawnCleanup(params: {
  childSessionKey: string;
  target: SessionTarget;
  resolveGatewayContext: GatewayContextResolver;
  isCurrent: () => boolean;
  canAbortAcceptedRun: () => boolean;
  getSessionIdentity: () => {
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  };
}) {
  const context = params.resolveGatewayContext();
  const dispatchCleanup = bindGatewayLifecycleRequest(params.resolveGatewayContext);
  let acceptedRun:
    | {
        runId: string;
        entry: RpcSourceRef | undefined;
        operationalRunInstance: RpcSourceRef["adapter"]["operationalRunInstance"];
      }
    | undefined;
  const isCurrent = (method: "sessions.delete" | "chat.abort" = "sessions.delete") => {
    if (!context || params.resolveGatewayContext() !== context) {
      return false;
    }
    const ownsRequest = method === "chat.abort" ? params.canAbortAcceptedRun() : params.isCurrent();
    if (!ownsRequest) {
      return false;
    }
    const identity = params.getSessionIdentity();
    if (!identity.expectedSessionId || !identity.expectedLifecycleRevision) {
      return false;
    }
    const currentRun =
      acceptedRun &&
      getRpcSourceForGateway(acceptedRun.runId, params.resolveGatewayContext, params.target);
    return (
      !currentRun ||
      (currentRun === acceptedRun?.entry &&
        currentRun.adapter.operationalRunInstance === acceptedRun?.operationalRunInstance &&
        getRpcSourceIdentity(currentRun).sessionKey === params.childSessionKey &&
        getRpcSourceIdentity(currentRun).sessionId === identity.expectedSessionId)
    );
  };
  const callGateway: GatewayCall = async (request) => {
    const method = request.method;
    if (method !== "sessions.delete" && method !== "chat.abort") {
      throw new Error("Subagent cleanup cannot dispatch this Gateway method");
    }
    const identity = params.getSessionIdentity();
    const payload = request.params;
    const assertCurrent = () => {
      const currentIdentity = params.getSessionIdentity();
      if (
        !isCurrent(method) ||
        currentIdentity.expectedSessionId !== identity.expectedSessionId ||
        currentIdentity.expectedLifecycleRevision !== identity.expectedLifecycleRevision
      ) {
        throw new Error("Subagent spawn no longer owns this cleanup");
      }
      if (method === "sessions.delete") {
        if (
          payload.key !== params.childSessionKey ||
          payload.expectedSessionId !== identity.expectedSessionId ||
          payload.expectedLifecycleRevision !== identity.expectedLifecycleRevision
        ) {
          throw new Error("Subagent cleanup session does not match its owner");
        }
      } else if (
        !acceptedRun ||
        payload.sessionKey !== params.childSessionKey ||
        payload.runId !== acceptedRun.runId
      ) {
        throw new Error("Subagent cleanup run does not match its accepted owner");
      }
      request.assertDispatchCurrent?.();
    };
    assertCurrent();
    if (
      method === "chat.abort" &&
      (!acceptedRun?.entry ||
        getRpcSourceForGateway(acceptedRun.runId, params.resolveGatewayContext, params.target) !==
          acceptedRun.entry)
    ) {
      return { aborted: false, runIds: [] };
    }
    if (!context?.recoveryRuntime) {
      throw new Error("Subagent cleanup Gateway is unavailable");
    }
    return await dispatchCleanup({
      method,
      params: payload,
      assertDispatchCurrent: assertCurrent,
      timeoutMs: request.timeoutMs ?? null,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  };
  const terminateAcceptedRun =
    context && context.localEmbedded !== true
      ? async (): Promise<AcceptedRunTerminationResult> => {
          if (!acceptedRun) {
            return { status: "failed", error: new Error("Subagent cleanup has no accepted run") };
          }
          const { runId } = acceptedRun;
          try {
            const response = await requestAcceptedRunAbort({
              childSessionKey: params.childSessionKey,
              gatewayRunId: runId,
              callGateway,
              isCurrent: () => isCurrent("chat.abort"),
            });
            if (
              !isMatchingAbortResponse(response, runId) &&
              !isDefinitiveAbortMiss(response, runId)
            ) {
              throw new Error("Gateway did not confirm accepted child termination");
            }
            return { status: "settled" };
          } catch (error) {
            // Keep uncertain children discoverable; their Gateway still owns execution and shutdown.
            return { status: "failed", error };
          }
        }
      : undefined;
  return {
    isCurrent,
    callGateway,
    terminateAcceptedRun,
    bindAcceptedRun: (runId: string) => {
      if (acceptedRun) {
        throw new Error("Subagent cleanup already owns an accepted run");
      }
      const entry = getRpcSourceForGateway(runId, params.resolveGatewayContext, params.target);
      acceptedRun = { runId, entry, operationalRunInstance: entry?.adapter.operationalRunInstance };
    },
  };
}

function isMatchingAbortResponse(response: unknown, gatewayRunId: string): boolean {
  const result = asNullableRecord(response);
  return (
    result?.aborted === true &&
    Array.isArray(result.runIds) &&
    result.runIds.some((runId) => runId === gatewayRunId)
  );
}

function isDefinitiveAbortMiss(response: unknown, gatewayRunId: string): boolean {
  const result = asNullableRecord(response);
  return (
    typeof result?.aborted === "boolean" &&
    Array.isArray(result.runIds) &&
    result.runIds.every((runId) => typeof runId === "string") &&
    !result.runIds.includes(gatewayRunId)
  );
}

type SessionCleanupOptions = {
  childAgentId?: string;
  isCurrent?: () => boolean;
  emitLifecycleHooks?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  callGateway?: GatewayCall;
  timeoutMs?: number;
};

function requestProvisionalSessionCleanup(
  childSessionKey: string,
  options?: SessionCleanupOptions,
) {
  return deleteSubagentSessionForCleanup({
    ...options,
    childSessionKey,
    callGateway: options?.callGateway ?? callSubagentGateway,
    deleteTranscript: true,
    timeoutMs: options?.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
  });
}

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  return (await requestProvisionalSessionCleanup(childSessionKey, options)) === "deleted";
}

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  isCurrent?: () => boolean;
  callGateway?: GatewayCall;
  childSessionKey: string;
  childAgentId?: string;
  attachmentId?: string;
  emitLifecycleHooks?: boolean;
  waitForSessionDeletion?: boolean;
  waitForCleanup?: () => Promise<void> | undefined;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<{ attachmentsRemoved: boolean; sessionDeleted: boolean }> {
  const {
    childSessionKey,
    attachmentId,
    waitForSessionDeletion,
    waitForCleanup,
    ...sessionCleanupOptions
  } = params;
  let attachmentsRemoved = true;
  if (attachmentId) {
    try {
      await cleanupMaterializedSubagentAttachments({
        childSessionKey,
        childAgentId: params.childAgentId,
        attachmentId,
        isCurrent: params.isCurrent,
      });
    } catch {
      attachmentsRemoved = false;
    }
  }
  if (waitForSessionDeletion) {
    await waitForCleanup?.();
  }
  return {
    attachmentsRemoved,
    sessionDeleted: await cleanupProvisionalSession(childSessionKey, sessionCleanupOptions),
  };
}

export async function terminateFailedRegistrationRun(params: {
  childSessionKey: string;
  gatewayRunId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  isCleanupCurrent: () => boolean;
  isAbortCurrent: () => boolean;
  cleanupOwner?: ReturnType<typeof bindSubagentSpawnCleanup>;
}): Promise<string | undefined> {
  // A failed required registration stops its accepted run while uncertain
  // or retained registry data still forbids deleting the session.
  const deleteSessionOnMiss = params.isCleanupCurrent();
  if (!deleteSessionOnMiss && params.cleanupOwner?.terminateAcceptedRun) {
    const termination = await params.cleanupOwner.terminateAcceptedRun();
    if (termination.status !== "settled") {
      return (
        `Child termination is not confirmed: ${formatErrorMessage(termination.error)}. ` +
        "Its session is retained; stop the child by its run ID or restart the Gateway."
      );
    }
  } else {
    await terminateAcceptedCollectorRun({
      ...params,
      isCurrent: deleteSessionOnMiss ? params.isCleanupCurrent : params.isAbortCurrent,
      sessionCleanup: deleteSessionOnMiss ? "delete-on-abort-miss" : "preserve",
      ...(params.cleanupOwner ? { callGateway: params.cleanupOwner.callGateway } : {}),
    });
  }
  return undefined;
}

async function requestAcceptedRunAbort(params: AcceptedRunAbortParams): Promise<unknown> {
  const call = params.callGateway ?? callSubagentGateway;
  return await call({
    method: "chat.abort",
    params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
    ...(params.isCurrent
      ? {
          assertDispatchCurrent: () => {
            if (params.isCurrent && !params.isCurrent()) {
              throw new Error("Subagent spawn no longer owns this accepted run");
            }
          },
        }
      : {}),
    timeoutMs: params.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
  });
}

export async function terminateAcceptedCollectorRun(params: {
  isCurrent?: () => boolean;
  childSessionKey: string;
  gatewayRunId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  callGateway?: GatewayCall;
  timeoutMs?: number;
  sessionCleanup?: "delete-on-abort-miss" | "preserve";
}): Promise<void> {
  const call = params.callGateway ?? callSubagentGateway;
  const timeoutMs = params.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS;
  try {
    const response = await requestAcceptedRunAbort(params);
    if (
      isMatchingAbortResponse(response, params.gatewayRunId) ||
      (params.sessionCleanup === "preserve" && isDefinitiveAbortMiss(response, params.gatewayRunId))
    ) {
      return;
    }
    if (params.sessionCleanup === "preserve") {
      throw new Error("Gateway did not confirm accepted child termination");
    }
  } catch (error) {
    if (params.sessionCleanup === "preserve") {
      throw error;
    }
    // Exact-session deletion can still stop a provisional child after an RPC failure.
  }
  const cleanup = await requestProvisionalSessionCleanup(params.childSessionKey, {
    isCurrent: params.isCurrent,
    expectedSessionId: params.expectedSessionId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    callGateway: call,
    timeoutMs,
  });
  if (cleanup === "failed" && params.isCurrent?.() !== false) {
    throw new Error("Gateway did not confirm accepted child cleanup");
  }
}
