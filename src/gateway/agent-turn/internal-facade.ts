import {
  type AgentWaitParams,
  type ErrorShape,
  validateAgentParams,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { removedPluginCapabilityDescriptor } from "../../plugins/removed-capability-error.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  isRpcSourceExecuting,
  isRpcSourceQueued,
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { abortChatRunById } from "../chat-abort.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import {
  type GatewayMethodDispatchResponse,
  throwIfGatewayDispatchAborted,
  waitForGatewayDispatch,
  unwrapGatewayMethodDispatchResponse,
} from "../server-in-process-dispatch.js";
import {
  createRequestGatewayMethodRegistry,
  runWithGatewayRequestEnvelope,
} from "../server-methods.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { authorizeGatewayRequestPreDispatch } from "../server-methods/request-authorization.js";
import type { GatewayRequestOptions } from "../server-methods/types.js";
import { validateGatewayMethodParams } from "../server-methods/validation.js";
import { runWithGatewayObservationScope } from "../server-request-lifecycle.js";
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

const REMOVED_START_OWNER_EXPIRY = removedPluginCapabilityDescriptor(
  "startOwner.observe().expiresAtMs",
  "Use startOwner.observe().startDeadlineAtMs for the admission-to-execution-start deadline; it does not limit an already executing turn.",
);

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
        recoveryInput: dispatchOptions.recoveryInput,
        controllerInput: dispatchOptions.controllerInput,
        assertPreparationCurrent: dispatchOptions.assertAdmissionCurrent,
      });
      // Turn admission owns its own authority; this pre-dispatch check transfers no custody.
      authorization.sessionMutationAuthorization?.release?.();
      authorization.sessionAccessAuthority?.release();
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
      let privateSourceSettlement: Promise<void> | undefined;
      // Acceptance publishes the abort owner before this callback runs. Retain that exact
      // entry so a late deadline cannot cancel a same-run-id successor.
      let acceptedAbortOwner: { entry: RpcSourceRef; runId: string } | undefined;
      let emittedAbortOwner: { entry: RpcSourceRef; runId: string } | undefined;
      let startOwnerPublished = false;
      let sourceIdentityLost = false;
      const isSourceIdentityCurrent = (owner: RpcSourceRef) => {
        try {
          options.assertContextCurrent?.();
          const identity = getRpcSourceIdentity(owner);
          // Losing the captured source is permanent, independently of its own abort.
          sourceIdentityLost ||=
            options.getContext() !== context ||
            !isRpcSourceRegistered(owner) ||
            owner.input.protocolRunId !== expectedRunId ||
            getAgentEventLifecycleGeneration() !== lifecycleGeneration ||
            getRpcSourceLifecycleGeneration(owner) !== lifecycleGeneration ||
            (expectedAgentId !== undefined && identity.agentId !== expectedAgentId) ||
            (!isRpcSourceExecuting(owner) && identity.sessionId !== expectedSessionId) ||
            identity.sessionKey !== expectedSessionKey;
        } catch {
          sourceIdentityLost = true;
        }
        return !sourceIdentityLost;
      };
      const publishStartOwner = (runId: string, owner: RpcSourceRef) => {
        const identity = getRpcSourceIdentity(owner);
        if (
          startOwnerPublished ||
          !dispatchOptions.onStartOwner ||
          runId !== expectedRunId ||
          (expectedAgentId !== undefined && identity.agentId !== expectedAgentId) ||
          identity.sessionKey !== expectedSessionKey ||
          identity.sessionId !== expectedSessionId ||
          getRpcSourceLifecycleGeneration(owner) !== lifecycleGeneration ||
          !isRpcSourceRegistered(owner)
        ) {
          return;
        }
        startOwnerPublished = true;
        const observe = () => {
          if (!isSourceIdentityCurrent(owner)) {
            return undefined;
          }
          const executionStarted = isRpcSourceExecuting(owner);
          if (owner.input.abortSignal.aborted || owner.input.retirementRequested === true) {
            return undefined;
          }
          // The start watch is complete; attempt policy may itself read this owner.
          const watchdog = executionStarted ? undefined : owner.input.claim?.operation?.watchdog;
          const snapshot = watchdog?.snapshot();
          const decision = snapshot?.current ? watchdog?.decide() : undefined;
          const deadlineAtMs = decision
            ? decision.action === "observe" || decision.action === "warn"
              ? Math.min(
                  snapshot?.executionDeadlineAtMs ?? Infinity,
                  decision.deadlineAtMs ?? Infinity,
                )
              : Date.now()
            : undefined;
          return Object.defineProperty(
            {
              executionStarted,
              startDeadlineAtMs:
                deadlineAtMs !== undefined
                  ? Number.isFinite(deadlineAtMs)
                    ? deadlineAtMs
                    : null
                  : isRpcSourceQueued(owner) && owner.input.phase === "waiting"
                    ? null
                    : undefined,
            },
            "expiresAtMs",
            REMOVED_START_OWNER_EXPIRY,
          );
        };
        dispatchOptions.onStartOwner({
          observe,
          // Captured registration, not a later run-id lookup, owns cancellation.
          abort: () =>
            observe()?.executionStarted === false &&
            abortChatRunById(context, {
              runId,
              expectedEntry: owner,
              sessionKey: getRpcSourceIdentity(owner).sessionKey,
              stopReason: "timeout",
            }).aborted,
        });
      };
      let pendingCancelReason: "rpc" | "timeout" | undefined;
      const cancelAcceptedRun = (reason: "rpc" | "timeout") => {
        pendingCancelReason ??= reason;
        const owner = acceptedAbortOwner;
        if (!owner || !isRpcSourceRegistered(owner.entry)) {
          return;
        }
        abortChatRunById(context, {
          runId: owner.runId,
          sessionKey: getRpcSourceIdentity(owner.entry).sessionKey,
          expectedEntry: owner.entry,
          stopReason: pendingCancelReason,
        });
      };
      const io: AgentTurnIo = {
        emitStartOwner: (runId, owner) => {
          emittedAbortOwner = { runId, entry: owner };
          if (dispatchOptions.privateCompletion) {
            privateSourceSettlement = owner.input.settlement.promise;
          }
          publishStartOwner(runId, owner);
        },
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
              typeof meta?.runId === "string" && meta.runId.length ? meta.runId : undefined;
            const acceptedEntry =
              emittedAbortOwner &&
              emittedAbortOwner.runId === acceptedRunId &&
              isRpcSourceRegistered(emittedAbortOwner.entry)
                ? emittedAbortOwner.entry
                : acceptedRunId
                  ? getRpcSourceForGateway(acceptedRunId, context.resolveGatewayContext)
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
            if (meta?.cached === true && acceptedEntry && isRpcSourceExecuting(acceptedEntry)) {
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
        let releaseExecutionSource: (() => void) | undefined;
        try {
          releaseExecutionSource = dispatchOptions.executionSource?.retain?.();
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
              if (dispatchOptions.prepareDispatchCurrent) {
                await dispatchOptions.prepareDispatchCurrent();
              }
              throwIfGatewayDispatchAborted(method, dispatchOptions.signal);
              entry?.assertOpen();
              options.assertContextCurrent?.();
              dispatchOptions.assertAdmissionCurrent?.();
              entry?.release();
              const principal = captureAgentTurnPrincipal(options.client);
              const preflight = await prepareAgentRequestPreflight({
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
                controllerInput: dispatchOptions.controllerInput,
                preflight,
                principal,
                io,
                onRunObserved,
                assertAdmissionCurrent: dispatchOptions.assertAdmissionCurrent,
                assertCancellationCurrent: dispatchOptions.assertCancellationCurrent
                  ? () => {
                      const owner = emittedAbortOwner?.entry;
                      if (
                        !owner ||
                        emittedAbortOwner?.runId !== expectedRunId ||
                        !owner.input.abortSignal.aborted ||
                        !isSourceIdentityCurrent(owner)
                      ) {
                        throw new Error("Canceled agent request no longer owns its RPC source");
                      }
                      dispatchOptions.assertCancellationCurrent?.();
                    }
                  : undefined,
                executionSource: dispatchOptions.executionSource,
                privateCompletion: dispatchOptions.privateCompletion,
                replyExpectation: dispatchOptions.replyExpectation,
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
          releaseExecutionSource?.();
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
        dispatchOptions.privateCompletion
          ? response.then(async (result) => {
              // Replay alone does not release source custody. Join this exact
              // dispatch, including refusal cleanup, before permitting retry.
              await privateSourceSettlement;
              options.assertContextCurrent?.();
              return result;
            })
          : response,
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
    prepareDispatchCurrent?: () => Promise<void>,
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
      const result = context.trackExecution(async () => {
        preparationOwnedByExecution = true;
        try {
          const observe = async (retainRoot?: () => void) => {
            const authorization = await authorizeGatewayRequestPreDispatch({
              method,
              requestParams: params,
              client: options.client,
              context,
              methodRegistry,
            });
            authorization.sessionMutationAuthorization?.release?.();
            authorization.sessionAccessAuthority?.release();
            throwIfGatewayDispatchAborted(method, signal);
            entry?.assertOpen();
            if (authorization.error) {
              return throwEnvelopeRejection(method, authorization.error);
            }
            const validationError = validateGatewayMethodParams(
              params,
              validateAgentWaitParams,
              method,
            );
            if (validationError) {
              return throwEnvelopeRejection(method, validationError);
            }
            options.assertContextCurrent?.();
            return await runWithGatewayRequestEnvelope(
              method,
              options.client,
              async () => {
                retainRoot?.();
                const { createAgentTurnService } = await import("./agent-turn-service.js");
                if (prepareDispatchCurrent) {
                  await prepareDispatchCurrent();
                }
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
                signal,
              },
            );
          };
          return await (methodRegistry.isObservation(method)
            ? runWithGatewayObservationScope(
                method,
                observe,
                [signal, options.client?.connectionSignal],
                (error) => throwEnvelopeRejection(method, error),
              )
            : observe());
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
