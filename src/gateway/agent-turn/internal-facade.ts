import {
  type AgentWaitParams,
  type ErrorShape,
  validateAgentParams,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import {
  type GatewayMethodDispatchResponse,
  throwIfGatewayDispatchAborted,
  waitForGatewayDispatch,
  unwrapGatewayMethodDispatchResponse,
} from "../server-in-process-dispatch.js";
import {
  authorizeGatewayRequestPreDispatch,
  createRequestGatewayMethodRegistry,
  runWithGatewayRequestEnvelope,
} from "../server-methods.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayRequestOptions } from "../server-methods/types.js";
import { validateGatewayMethodParams } from "../server-methods/validation.js";
import type {
  InternalAgentTurnDispatchOptions,
  InternalAgentTurnFacade,
  InternalAgentTurnPrincipalOptions,
} from "./internal-facade.types.js";
import type { AgentTurnIo } from "./types.js";

type InternalAgentTurnFacadeOptions = InternalAgentTurnPrincipalOptions & {
  getContext: () => GatewayRequestOptions["context"];
  getMethodRegistry?: () => GatewayMethodRegistry;
};

function throwEnvelopeRejection(method: string, error: ErrorShape): never {
  return unwrapGatewayMethodDispatchResponse(method, {
    ok: false,
    error,
  }) as never;
}

/** Typed, frame-free access to agent turns owned by the running Gateway instance. */
export function createInternalAgentTurnFacade(
  options: InternalAgentTurnFacadeOptions,
): InternalAgentTurnFacade {
  const isWebchatConnect = options.isWebchatConnect ?? (() => false);
  const getMethodRegistry = options.getMethodRegistry ?? createRequestGatewayMethodRegistry;

  const dispatchRaw = async (
    request: AgentRunRequest,
    dispatchOptions: InternalAgentTurnDispatchOptions = {},
  ): Promise<GatewayMethodDispatchResponse> => {
    const method = "agent";
    throwIfGatewayDispatchAborted(method, dispatchOptions.signal);
    dispatchOptions.assertAdmissionCurrent?.();
    options.assertContextCurrent?.();
    const context = options.getContext();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const {
      agentId: expectedAgentId,
      expectedExistingSessionId: expectedSessionId,
      idempotencyKey: expectedRunId,
      sessionKey: expectedSessionKey,
    } = request;
    const entry = context.requestEntryLifetime?.enter({
      req: { method, params: request },
      client: options.client,
      context,
    });
    let preparationOwnedByExecution = false;
    try {
      const methodRegistry = getMethodRegistry();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method,
        requestParams: request,
        client: options.client,
        context,
        methodRegistry,
      });
      throwIfGatewayDispatchAborted(method, dispatchOptions.signal);
      entry?.assertOpen();
      if (authorization.error) {
        return { ok: false, error: authorization.error };
      }
      const validationError = validateGatewayMethodParams(request, validateAgentParams, method);
      if (validationError) {
        return { ok: false, error: validationError };
      }
      options.assertContextCurrent?.();
      dispatchOptions.assertAdmissionCurrent?.();
      let acceptance: GatewayMethodDispatchResponse | undefined;
      let final: GatewayMethodDispatchResponse | undefined;
      const acceptanceResult = createDeferredCore<GatewayMethodDispatchResponse>();
      let finalResult: Deferred<GatewayMethodDispatchResponse> | undefined;
      let postAcceptanceError: Error | undefined;
      // Acceptance publishes the abort owner before this callback runs. Retain that exact
      // entry so a late deadline cannot cancel a same-run-id successor.
      let acceptedAbortOwner: { entry: ChatAbortControllerEntry; runId: string } | undefined;
      let startOwnerPublished = false;
      const publishStartOwner = (runId: string, owner: ChatAbortControllerEntry) => {
        if (
          startOwnerPublished ||
          !dispatchOptions.onStartOwner ||
          runId !== expectedRunId ||
          (expectedAgentId !== undefined && owner.agentId !== expectedAgentId) ||
          owner.sessionKey !== expectedSessionKey ||
          owner.sessionId !== expectedSessionId ||
          owner.lifecycleGeneration !== lifecycleGeneration ||
          context.chatAbortControllers.get(runId) !== owner
        ) {
          return;
        }
        startOwnerPublished = true;
        const observe = () => {
          try {
            options.assertContextCurrent?.();
          } catch {
            return undefined;
          }
          return context.chatAbortControllers.get(runId) === owner &&
            getAgentEventLifecycleGeneration() === lifecycleGeneration &&
            owner.lifecycleGeneration === lifecycleGeneration &&
            (expectedAgentId === undefined || owner.agentId === expectedAgentId) &&
            owner.sessionId === expectedSessionId &&
            owner.sessionKey === expectedSessionKey &&
            !owner.controller.signal.aborted &&
            owner.registrationCleanupRequested !== true
            ? { executionStarted: owner.executionStarted === true, expiresAtMs: owner.expiresAtMs }
            : undefined;
        };
        dispatchOptions.onStartOwner({
          observe,
          // Captured registration, not a later run-id lookup, owns cancellation.
          abort: () =>
            observe()?.executionStarted === false &&
            abortChatRunById(context, {
              runId,
              sessionKey: owner.sessionKey,
              stopReason: "timeout",
            }).aborted,
        });
      };
      let pendingCancelReason: "rpc" | "timeout" | undefined;
      const cancelAcceptedRun = (reason: "rpc" | "timeout") => {
        pendingCancelReason ??= reason;
        const owner = acceptedAbortOwner;
        if (!owner || context.chatAbortControllers.get(owner.runId) !== owner.entry) {
          return;
        }
        abortChatRunById(context, {
          runId: owner.runId,
          sessionKey: owner.entry.sessionKey,
          stopReason: pendingCancelReason,
        });
      };
      const io: AgentTurnIo = {
        emitStartOwner: publishStartOwner,
        emitAcceptance: (frame, meta) => {
          if (!acceptance) {
            acceptance = {
              ok: frame[0],
              payload: frame[1],
              error: frame[2],
              ...(meta ? { meta } : {}),
            };
            acceptanceResult.resolve(acceptance);
            const acceptedRunId =
              typeof meta?.runId === "string" && meta.runId.trim() ? meta.runId.trim() : undefined;
            const acceptedEntry = acceptedRunId
              ? context.chatAbortControllers.get(acceptedRunId)
              : undefined;
            if (acceptedRunId && acceptedEntry) {
              acceptedAbortOwner = { entry: acceptedEntry, runId: acceptedRunId };
              if (pendingCancelReason) {
                cancelAcceptedRun(pendingCancelReason);
              }
              if (meta?.cached === true) {
                publishStartOwner(acceptedRunId, acceptedEntry);
              }
            }
            if (
              meta?.cached === true &&
              acceptedRunId &&
              context.chatAbortControllers.get(acceptedRunId)?.executionStarted === true
            ) {
              dispatchOptions.onExecutionStarted?.();
            }
          }
        },
        emitFinal: (frame, meta) => {
          if (!final) {
            final = {
              ok: frame[0],
              payload: frame[1],
              error: frame[2],
              ...(meta ? { meta } : {}),
            };
            finalResult?.resolve(final);
          }
        },
        ...(dispatchOptions.onExecutionStarted
          ? { emitExecutionStarted: dispatchOptions.onExecutionStarted }
          : {}),
      };
      const operation = context.trackExecution(async () => {
        preparationOwnedByExecution = true;
        try {
          return await runWithGatewayRequestEnvelope(
            method,
            options.client,
            async () => {
              const [
                { prepareAgentRequestPreflight },
                { createAgentTurnService },
                { captureAgentTurnPrincipal, resolveAgentTurnRunObserver },
              ] = await Promise.all([
                import("./agent-request-preflight.js"),
                import("./agent-turn-service.js"),
                import("./principal.js"),
              ]);
              throwIfGatewayDispatchAborted(method, dispatchOptions.signal);
              entry?.assertOpen();
              options.assertContextCurrent?.();
              dispatchOptions.assertAdmissionCurrent?.();
              entry?.release();
              const principal = captureAgentTurnPrincipal(options.client);
              const preflight = prepareAgentRequestPreflight({
                request,
                context,
                client: principal,
                io,
              });
              if (!preflight) {
                return;
              }
              const onRunObserved = resolveAgentTurnRunObserver({
                principal,
                registerToolEventRecipient: context.registerToolEventRecipient,
              });
              await createAgentTurnService(
                { context, isWebchatConnect },
                options.assertContextCurrent,
              ).startTurn({
                preflight,
                principal,
                io,
                onRunObserved,
                assertAdmissionCurrent: dispatchOptions.assertAdmissionCurrent,
                privateCompletion: dispatchOptions.privateCompletion,
                settleWakeReplay: dispatchOptions.settleWakeReplay,
              });
            },
            {
              context,
              isWebchatConnect,
              methodRegistry,
              reject: (error) => io.emitAcceptance([false, undefined, error]),
            },
          );
        } finally {
          entry?.release();
        }
      });
      void operation.then(
        () => {
          if (!acceptance) {
            acceptanceResult.reject(
              new Error(`Gateway method "${method}" completed without a response.`),
            );
          }
        },
        (error: unknown) => {
          const dispatchError = error instanceof Error ? error : new Error(String(error));
          if (acceptance) {
            postAcceptanceError = dispatchError;
            finalResult?.reject(dispatchError);
            return;
          }
          acceptanceResult.reject(dispatchError);
        },
      );
      const response = (async () => {
        const first = acceptance ?? (await acceptanceResult.promise);
        if (
          dispatchOptions.expectFinal !== true ||
          (first.payload as { status?: unknown } | undefined)?.status !== "accepted"
        ) {
          return first;
        }
        dispatchOptions.onAccepted?.(first.payload);
        if (postAcceptanceError) {
          throw postAcceptanceError;
        }
        return final ?? (await (finalResult = createDeferredCore()).promise);
      })();
      return await waitForGatewayDispatch(
        method,
        response,
        dispatchOptions.timeoutMs,
        dispatchOptions.signal,
        dispatchOptions.cancelOnDeadline || dispatchOptions.onSignalAbort
          ? async () => {
              if (dispatchOptions.cancelOnDeadline) {
                cancelAcceptedRun("rpc");
              }
              await dispatchOptions.onSignalAbort?.();
            }
          : undefined,
        dispatchOptions.cancelOnDeadline ? () => cancelAcceptedRun("timeout") : undefined,
      );
    } finally {
      if (!preparationOwnedByExecution) {
        entry?.release();
      }
    }
  };

  const dispatch = async <T = unknown>(
    request: AgentRunRequest,
    dispatchOptions: InternalAgentTurnDispatchOptions | number = {},
  ): Promise<T> => {
    const normalizedOptions =
      typeof dispatchOptions === "number" ? { timeoutMs: dispatchOptions } : dispatchOptions;
    return unwrapGatewayMethodDispatchResponse(
      "agent",
      await dispatchRaw(request, normalizedOptions),
    ) as T;
  };

  const wait = async <T = unknown>(
    params: AgentWaitParams,
    timeoutMs?: number,
    signal?: AbortSignal,
    onSignalAbort?: () => Promise<void> | void,
  ): Promise<T> => {
    const method = "agent.wait";
    throwIfGatewayDispatchAborted(method, signal);
    options.assertContextCurrent?.();
    const context = options.getContext();
    const entry = context.requestEntryLifetime?.enter({
      req: { method, params },
      client: options.client,
      context,
    });
    let preparationOwnedByExecution = false;
    try {
      const methodRegistry = getMethodRegistry();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method,
        requestParams: params,
        client: options.client,
        context,
        methodRegistry,
      });
      throwIfGatewayDispatchAborted(method, signal);
      entry?.assertOpen();
      if (authorization.error) {
        return throwEnvelopeRejection(method, authorization.error);
      }
      const validationError = validateGatewayMethodParams(params, validateAgentWaitParams, method);
      if (validationError) {
        return throwEnvelopeRejection(method, validationError);
      }
      options.assertContextCurrent?.();
      const result = context.trackExecution(async () => {
        preparationOwnedByExecution = true;
        try {
          return await runWithGatewayRequestEnvelope(
            method,
            options.client,
            async () => {
              const { createAgentTurnService } = await import("./agent-turn-service.js");
              throwIfGatewayDispatchAborted(method, signal);
              entry?.assertOpen();
              options.assertContextCurrent?.();
              entry?.release();
              const observation = await createAgentTurnService({
                context,
                isWebchatConnect,
              }).waitForTurn(params);
              return observation.result;
            },
            {
              context,
              isWebchatConnect,
              methodRegistry,
              reject: (error) => throwEnvelopeRejection(method, error),
            },
          );
        } finally {
          entry?.release();
        }
      });
      return (await waitForGatewayDispatch(method, result, timeoutMs, signal, onSignalAbort)) as T;
    } finally {
      if (!preparationOwnedByExecution) {
        entry?.release();
      }
    }
  };

  return { dispatch, dispatchRaw, wait };
}
