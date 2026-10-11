import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { callGateway } from "../../../gateway/call.js";
import { waitForChatAbortControllerRemoval } from "../../../gateway/chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { cleanupMaterializedSubagentAttachments } from "./subagent-attachments.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
type GatewayCall = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;
type AcceptedRunAbortParams = {
  childSessionKey: string;
  gatewayRunId: string;
  isCurrent?: () => boolean;
  callGateway?: GatewayCall;
  timeoutMs?: number;
  signal?: AbortSignal;
};
type AcceptedRunTerminationResult =
  | { status: "settled" }
  | { status: "pending" | "failed"; error: unknown };

/** Binds rollback to the session this spawn created, independently of its operator's lifetime. */
export function bindSubagentSpawnCleanup(params: {
  childSessionKey: string;
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
        entry: ChatAbortControllerEntry | undefined;
        operationalRunInstance: ChatAbortControllerEntry["operationalRunInstance"];
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
        !isCurrent(method) ||
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
      ...(request.signal ? { signal: request.signal } : {}),
    });
  };
  const terminateAcceptedRun =
    context && context.localEmbedded !== true
      ? async (retainAdmission: () => () => void): Promise<AcceptedRunTerminationResult> => {
          if (!acceptedRun) {
            return { status: "failed", error: new Error("Subagent cleanup has no accepted run") };
          }
          const { runId, entry, operationalRunInstance } = acceptedRun;
          const abort = async (signal?: AbortSignal) => {
            const response = await requestAcceptedRunAbort({
              childSessionKey: params.childSessionKey,
              gatewayRunId: runId,
              callGateway,
              isCurrent: () => isCurrent("chat.abort"),
              signal,
            });
            if (
              !isMatchingAbortResponse(response, runId) &&
              !isDefinitiveAbortMiss(response, runId)
            ) {
              throw new Error("Gateway did not confirm accepted child termination");
            }
          };
          let abortError: unknown;
          try {
            await abort();
            return { status: "settled" };
          } catch (error) {
            abortError = error;
          }
          let releaseAdmission: (() => void) | undefined;
          const scheduling = createDeferredCore<AcceptedRunTerminationResult>();
          const fail = (error: unknown) => {
            releaseAdmission?.();
            const failure = new AggregateError(
              [abortError, error],
              `Child termination failed (${formatErrorMessage(abortError)}); cleanup failed (${formatErrorMessage(error)})`,
            );
            scheduling.resolve({ status: "failed", error: failure });
            context.logGateway.warn(`Accepted child ${runId}: ${failure.message}`);
          };
          try {
            releaseAdmission = retainAdmission();
            // This exact Gateway joins the tail after the spawning tool returns.
            const cleanup = context.trackExecution(async () => {
              const signal = getAsyncWorkSignal();
              try {
                if (!signal) {
                  throw new Error("Subagent cleanup requires its Gateway work lifetime");
                }
                signal.throwIfAborted();
                scheduling.resolve({ status: "pending", error: abortError });
                try {
                  await abort(signal);
                } catch (cleanupError) {
                  context.logGateway.warn(
                    `Accepted child ${runId} termination remains unconfirmed: ${formatErrorMessage(cleanupError)}`,
                  );
                  // Registry admission can retire while this exact child still owns execution.
                  if (
                    !signal.aborted &&
                    entry &&
                    context.chatAbortControllers.get(runId) === entry &&
                    entry.operationalRunInstance === operationalRunInstance
                  ) {
                    await waitForChatAbortControllerRemoval({
                      entries: context.chatAbortControllers,
                      targets: [{ runId, entry }],
                      timeoutMs: null,
                      signal,
                    }).catch((error: unknown) => {
                      if (!signal.aborted) {
                        throw error;
                      }
                    });
                  }
                }
              } finally {
                releaseAdmission?.();
              }
            });
            void cleanup.catch(fail);
          } catch (error) {
            fail(error);
          }
          return await scheduling.promise;
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
      const entry = context?.chatAbortControllers.get(runId);
      acceptedRun = { runId, entry, operationalRunInstance: entry?.operationalRunInstance };
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

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  isCurrent?: () => boolean;
  callGateway?: GatewayCall;
  childSessionKey: string;
  attachmentId?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
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
  retainAdmission?: () => () => void;
}): Promise<string | undefined> {
  // A failed required registration stops its accepted run while uncertain
  // or retained registry data still forbids deleting the session.
  const deleteSessionOnMiss = params.isCleanupCurrent();
  if (!deleteSessionOnMiss && params.retainAdmission && params.cleanupOwner?.terminateAcceptedRun) {
    const termination = await params.cleanupOwner.terminateAcceptedRun(params.retainAdmission);
    if (termination.status !== "settled") {
      return (
        `Child termination is not confirmed: ${formatErrorMessage(termination.error)}. ` +
        (termination.status === "pending"
          ? "Its session is retained, and Gateway cleanup is pending."
          : "Its session is retained; Gateway cleanup could not be scheduled.")
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
  params.signal?.throwIfAborted();
  return await call({
    method: "chat.abort",
    params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
    ...(params.isCurrent || params.signal
      ? {
          assertDispatchCurrent: () => {
            params.signal?.throwIfAborted();
            if (params.isCurrent && !params.isCurrent()) {
              throw new Error("Subagent spawn no longer owns this accepted run");
            }
          },
        }
      : {}),
    timeoutMs: params.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
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
    deleteTranscript: true,
    expectedSessionId: params.expectedSessionId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    callGateway: call,
    timeoutMs,
  });
  if (cleanup === "failed" && params.isCurrent?.() !== false) {
    throw new Error("Gateway did not confirm accepted child cleanup");
  }
}
