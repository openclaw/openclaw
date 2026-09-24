import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { callGateway } from "../../../gateway/call.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { cleanupMaterializedSubagentAttachments } from "./subagent-attachments.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
type GatewayCall = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;

/** Binds rollback to the session this spawn created, independently of its operator's lifetime. */
export function bindSubagentSpawnCleanup(params: {
  childSessionKey: string;
  resolveGatewayContext: GatewayContextResolver;
  isCurrent: () => boolean;
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
        entry: ChatAbortControllerEntry | undefined;
        operationalRunInstance: ChatAbortControllerEntry["operationalRunInstance"];
      }
    | undefined;
  const isCurrent = () => {
    if (!context || params.resolveGatewayContext() !== context || !params.isCurrent()) {
      return false;
    }
    const identity = params.getSessionIdentity();
    if (!identity.expectedSessionId || !identity.expectedLifecycleRevision) {
      return false;
    }
    const currentRun = acceptedRun && context.chatAbortControllers.get(acceptedRun.runId);
    return (
      !currentRun ||
      (currentRun === acceptedRun?.entry &&
        currentRun.operationalRunInstance === acceptedRun?.operationalRunInstance &&
        currentRun.sessionKey === params.childSessionKey &&
        currentRun.sessionId === identity.expectedSessionId)
    );
  };
  const callGateway: GatewayCall = async (request) => {
    const method = request.method;
    if (method !== "sessions.delete" && method !== "chat.abort") {
      throw new Error("Subagent cleanup cannot dispatch this Gateway method");
    }
    const identity = params.getSessionIdentity();
    const payload = asNullableRecord(request.params);
    const assertCurrent = () => {
      const currentIdentity = params.getSessionIdentity();
      if (
        !isCurrent() ||
        currentIdentity.expectedSessionId !== identity.expectedSessionId ||
        currentIdentity.expectedLifecycleRevision !== identity.expectedLifecycleRevision
      ) {
        throw new Error("Subagent spawn no longer owns this cleanup");
      }
      if (method === "sessions.delete") {
        if (
          payload?.key !== params.childSessionKey ||
          payload.expectedSessionId !== identity.expectedSessionId ||
          payload.expectedLifecycleRevision !== identity.expectedLifecycleRevision
        ) {
          throw new Error("Subagent cleanup session does not match its owner");
        }
      } else if (
        !acceptedRun ||
        payload?.sessionKey !== params.childSessionKey ||
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
        context?.chatAbortControllers.get(acceptedRun.runId) !== acceptedRun.entry)
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
    });
  };
  return {
    isCurrent,
    callGateway,
    bindAcceptedRun: (runId: string) => {
      if (acceptedRun) {
        throw new Error("Subagent cleanup already owns an accepted run");
      }
      const entry = context?.chatAbortControllers.get(runId);
      acceptedRun = { runId, entry, operationalRunInstance: entry?.operationalRunInstance };
    },
  };
}

function isMatchingAbortResponse(response: unknown, gatewayRunId: string): boolean {
  const result = asNullableRecord(response);
  if (!result) {
    return false;
  }
  return (
    result.aborted === true &&
    Array.isArray(result.runIds) &&
    result.runIds.some((runId) => runId === gatewayRunId)
  );
}

function isDefinitiveAbortMiss(response: unknown, gatewayRunId: string): boolean {
  const result = asNullableRecord(response);
  if (!result) {
    return false;
  }
  return (
    typeof result.aborted === "boolean" &&
    Array.isArray(result.runIds) &&
    result.runIds.every((runId) => typeof runId === "string") &&
    !result.runIds.includes(gatewayRunId)
  );
}

export async function retrySubagentCleanup(
  attempt: () => boolean | Promise<boolean>,
  options?: { shouldRetry?: () => boolean; onError?: (error: unknown) => void },
): Promise<boolean> {
  for (;;) {
    try {
      if (await attempt()) {
        return true;
      }
    } catch (error) {
      options?.onError?.(error);
    }
    if (options?.shouldRetry?.() === false) {
      return false;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
  }
}

type SessionCleanupOptions = {
  isCurrent?: () => boolean;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
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
    deleteTranscript: options?.deleteTranscript === true,
    timeoutMs: options?.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
  });
}

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  return (await requestProvisionalSessionCleanup(childSessionKey, options)) === "deleted";
}

async function waitForProvisionalSessionDeletion(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  let deleted = false;
  await retrySubagentCleanup(
    async () => {
      const outcome = await requestProvisionalSessionCleanup(childSessionKey, options);
      deleted = outcome === "deleted";
      return outcome !== "failed";
    },
    { shouldRetry: options?.isCurrent },
  );
  return deleted;
}

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  isCurrent?: () => boolean;
  callGateway?: GatewayCall;
  childSessionKey: string;
  attachmentId?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  waitForSessionDeletion?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<{ attachmentsRemoved: boolean; sessionDeleted: boolean }> {
  const { childSessionKey, attachmentId, waitForSessionDeletion, ...sessionCleanupOptions } =
    params;
  let attachmentsRemoved = true;
  if (attachmentId) {
    try {
      await cleanupMaterializedSubagentAttachments({
        childSessionKey,
        attachmentId,
        isCurrent: params.isCurrent,
      });
    } catch {
      attachmentsRemoved = false;
    }
  }
  return {
    attachmentsRemoved,
    sessionDeleted: await (
      waitForSessionDeletion ? waitForProvisionalSessionDeletion : cleanupProvisionalSession
    )(childSessionKey, sessionCleanupOptions),
  };
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
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  await retrySubagentCleanup(
    async () => {
      try {
        const response = await call({
          method: "chat.abort",
          params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
          timeoutMs,
        });
        if (isMatchingAbortResponse(response, params.gatewayRunId)) {
          return true;
        }
        if (
          params.sessionCleanup === "preserve" &&
          isDefinitiveAbortMiss(response, params.gatewayRunId)
        ) {
          return true;
        }
      } catch {
        if (params.sessionCleanup === "preserve") {
          return false;
        }
        // Fall through to exact-session deletion for provisional sessions only.
      }
      if (params.sessionCleanup === "preserve") {
        return false;
      }
      const cleanup = await requestProvisionalSessionCleanup(params.childSessionKey, {
        isCurrent: params.isCurrent,
        deleteTranscript: true,
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
        callGateway: call,
        timeoutMs,
      });
      // A changed lifecycle proves the accepted run no longer owns this session.
      return cleanup !== "failed" || params.isCurrent?.() === false;
    },
    {
      // A retired request scope can never dispatch again; retrying would retain
      // its Gateway forever without terminating the accepted run.
      shouldRetry: () =>
        params.isCurrent?.() !== false &&
        (!resolveGatewayContext || Boolean(resolveGatewayContext())),
    },
  );
}
