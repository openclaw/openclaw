import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  getPluginRuntimeGatewayNodeAuthorities,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { AgentDatabaseAdmissionError } from "../state/agent-database-admission.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import {
  consumeControlPlaneWriteBudget,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
} from "./control-plane-rate-limit.js";
import { errorShapeFromError } from "./error-shape.js";
import { createExpectedProfileBinding } from "./expected-profile.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import {
  coreGatewayHandlers,
  gatewayRouterUploadPolicyError,
} from "./server-methods/core-handlers.js";
import { prepareGatewayRequestHandler } from "./server-methods/lazy-core-handlers.js";
import { authorizeGatewayRequestPreDispatch } from "./server-methods/request-authorization.js";
import { isTargetedNonSafeGatewayRestartRequest } from "./server-methods/restart-request.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  captureGatewayRequestOperatorGuard,
  readGatewayRequestMutationAuthority,
  withSessionMutationCommitGuard,
} from "./server-methods/session-mutation-guards.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import type { GatewayRequestEntry } from "./server-request-entry.js";
import {
  isGatewayRootlessRequestAllowed,
  runGatewayPendingWorkContinuation,
  runWithGatewayObservationScope,
  workAdmissionUnavailableError,
} from "./server-request-lifecycle.js";
import { GatewayRpcDiagnostics } from "./server/ws-connection/request-diagnostics.js";
import type { GatewaySessionAccessAuthority } from "./session-access-authority.js";
import { sessionLog } from "./session-log.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { resolveRuntimeSessionParticipantRequest } from "./session-tool-participant.js";
import {
  startSlowRequestDiagnostics,
  type SessionSubscribePhase,
} from "./slow-request-diagnostics.js";
import { classifyGatewayStaleInstall } from "./stale-install.js";

export { coreGatewayHandlers };

/** Builds the per-request method registry from core, plugin, and explicit extra handlers. */
export function createRequestGatewayMethodRegistry(
  extraHandlers?: GatewayRequestHandlers,
): GatewayMethodRegistry {
  // Attached gateway methods must not be shadowed by agent-scoped registry loads.
  const gatewayPluginRegistry = getActivePluginRegistry();
  const gatewayPluginHandlers = gatewayPluginRegistry?.gatewayHandlers ?? {};
  const pluginMethodNames = new Set(Object.keys(gatewayPluginHandlers));
  const coreDescriptorHandlers = { ...coreGatewayHandlers };
  const auxHandlers: Array<[string, GatewayRequestHandler]> = [];
  for (const [method, extraHandler] of Object.entries(extraHandlers ?? {})) {
    // Tests and local harnesses can override classified core methods, but plugin-provided
    // methods win so a loaded plugin cannot be shadowed by a caller-local extra handler.
    if (pluginMethodNames.has(method)) {
      continue;
    }
    if (isCoreGatewayMethodClassified(method)) {
      coreDescriptorHandlers[method] = extraHandler;
    } else {
      auxHandlers.push([method, extraHandler]);
    }
  }
  return createGatewayMethodRegistry(
    [
      ...createCoreGatewayMethodDescriptors(coreDescriptorHandlers),
      ...(gatewayPluginRegistry ? createPluginGatewayMethodDescriptors(gatewayPluginRegistry) : []),
      ...createGatewayMethodDescriptorsFromHandlers({
        handlers: Object.fromEntries(auxHandlers),
        owner: { kind: "aux", area: "gateway-extra" },
        defaultScope: ADMIN_SCOPE,
      }),
    ],
    gatewayPluginRegistry ?? undefined,
  );
}

type GatewayRequestEnvelopeOptions<T> = Pick<
  GatewayRequestOptions,
  "context" | "isWebchatConnect" | "signal" | "hasCurrentClientAuthority"
> & {
  methodRegistry: GatewayMethodRegistry;
  requestParams?: unknown;
  admission?: "continuation";
  reject: (error: ReturnType<typeof errorShape>) => T | Promise<T>;
};

/** Runs admitted Gateway work inside the shared root and plugin request scopes. */
export async function runWithGatewayRequestEnvelope<T>(
  method: string,
  client: GatewayRequestOptions["client"],
  fn: () => T | Promise<T>,
  options: GatewayRequestEnvelopeOptions<T>,
): Promise<T> {
  const rejectRateLimitedControlPlaneWrite = (): ReturnType<typeof errorShape> | undefined => {
    if (!options.methodRegistry.isControlPlaneWrite(method)) {
      return undefined;
    }
    const budget = consumeControlPlaneWriteBudget({ client, method });
    if (budget.allowed) {
      return undefined;
    }
    const actor = resolveControlPlaneActor(client);
    options.context.logGateway.warn(
      `control-plane write rate-limited method=${method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`,
    );
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      {
        retryable: true,
        retryAfterMs: budget.retryAfterMs,
        details: {
          method,
          limit: `${CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS} per ${CONTROL_PLANE_RATE_LIMIT_WINDOW_MS / 1000}s`,
        },
      },
    );
  };
  const isSuspendPrepare = method === "gateway.suspend.prepare";
  const preAdmissionRateLimitError = isSuspendPrepare
    ? rejectRateLimitedControlPlaneWrite()
    : undefined;
  if (preAdmissionRateLimitError) {
    // Preparation must stay protected even before it owns the root admission that it closes.
    return await options.reject(preAdmissionRateLimitError);
  }
  const rootWorkAdmission =
    options.admission === "continuation"
      ? null
      : (tryBeginGatewayRootWorkAdmission(`ws:${method}`) ??
        (method === "gateway.restart.request" &&
        isTargetedNonSafeGatewayRestartRequest(options.requestParams)
          ? tryBeginGatewayPreparedRestartRootWorkAdmission()
          : null));
  if (!rootWorkAdmission) {
    // Completion frames arrive on separate socket chains. Their exact pending owner
    // may settle them without admitting a new root, including rootless shutdown cleanup.
    const continuation = runGatewayPendingWorkContinuation({
      method,
      client,
      requestParams: options.requestParams,
      context: options.context,
      admission: options.admission,
      run: invokeWithRequestScope,
    });
    if (continuation) {
      return await continuation;
    }
    if (options.admission === "continuation") {
      return await options.reject(
        errorShape(ErrorCodes.UNAVAILABLE, `${method} unavailable during gateway shutdown`),
      );
    }
  }
  if (isSuspendPrepare && rootWorkAdmission && !rootWorkAdmission.ownsRoot) {
    return await options.reject(
      errorShape(ErrorCodes.UNAVAILABLE, "gateway suspension cannot begin from a nested request", {
        retryable: true,
        retryAfterMs: 1_000,
        details: { method, reason: "nested-gateway-request" },
      }),
    );
  }
  if (!rootWorkAdmission && !isGatewayRootlessRequestAllowed(method)) {
    return await options.reject(workAdmissionUnavailableError(method));
  }
  async function invokeWithRequestScope() {
    const postAdmissionRateLimitError = isSuspendPrepare
      ? undefined
      : rejectRateLimitedControlPlaneWrite();
    // A closed admission must reject first so refused writes do not exhaust the controller's
    // budget and strand it behind rate limiting after suspension resumes.
    if (postAdmissionRateLimitError) {
      return await options.reject(postAdmissionRateLimitError);
    }
    const releaseForegroundWork = retainSessionListForegroundWork();
    try {
      const pluginRegistry =
        (options.methodRegistry.pluginRegistry as PluginRegistry | undefined) ??
        getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
        getActivePluginRegistry() ??
        undefined;
      return await withPluginRuntimeGatewayRequestScope(
        {
          context: options.context,
          // Detached turn admission needs the live instance resolver, not a captured request context.
          resolveGatewayContext: options.context.resolveGatewayContext,
          client,
          signal: options.signal,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          isWebchatConnect: options.isWebchatConnect,
          // Only an owner-bound in-process stream may retain admitted Full authority.
          ...(client?.internal?.nodeInvokeStream ? getPluginRuntimeGatewayNodeAuthorities() : {}),
          ...(pluginRegistry ? { pluginRegistry } : {}),
        },
        fn,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return await options.reject(error.error);
      }
      const staleInstall = classifyGatewayStaleInstall(error);
      if (staleInstall) {
        return await options.reject(staleInstall.error);
      }
      throw error;
    } finally {
      releaseForegroundWork();
    }
  }
  if (!rootWorkAdmission) {
    return await invokeWithRequestScope();
  }
  try {
    return await rootWorkAdmission.run(invokeWithRequestScope);
  } finally {
    rootWorkAdmission.release();
  }
}

/** Authorizes and dispatches one gateway JSON-RPC-style request. */
export async function handleGatewayRequest(
  opts: GatewayRequestOptions & {
    extraHandlers?: GatewayRequestHandlers;
    admission?: "continuation";
    requestEntry?: GatewayRequestEntry;
  },
  diagnostics?: GatewayRpcDiagnostics,
): Promise<void> {
  const { req, client, isWebchatConnect, context, signal, hasCurrentClientAuthority } = opts;
  // Keep the caller's current registry, including methods published after global registration.
  const methodRegistry =
    opts.methodRegistry?.getHandler(req.method) !== undefined
      ? opts.methodRegistry
      : createRequestGatewayMethodRegistry(opts.extraHandlers);
  const observation = methodRegistry.isObservation(req.method);
  let observationResponded = false;
  let respondCancelled = opts.respond;
  const dispatch = async (retainRoot?: () => void) => {
    const observationSignal = observation ? getAsyncWorkSignal() : undefined;
    using subscribeDiagnostics =
      req.method === "sessions.messages.subscribe"
        ? startSlowRequestDiagnostics<SessionSubscribePhase>(
            sessionLog,
            "slow session messages subscribe",
            req.method,
            "setup",
          )
        : undefined;
    const runtimeParticipant = resolveRuntimeSessionParticipantRequest(opts);
    if (runtimeParticipant === null) {
      return;
    }
    const profileBinding =
      opts.expectedProfileBinding ??
      (req.expectedProfileId === undefined
        ? undefined
        : await createExpectedProfileBinding(
            req.expectedProfileId,
            client,
            readGatewayRequestMutationAuthority(opts).assertLifetimeCurrent,
          ));
    // WS publication already owns the shared guard, including policy-close responses.
    const profileRespond =
      profileBinding && !opts.expectedProfileBinding
        ? profileBinding.guardResponse(opts.respond)
        : opts.respond;
    const respondUnobserved: GatewayRequestOptions["respond"] = runtimeParticipant
      ? (ok, ...response) => {
          if (ok) {
            runtimeParticipant.assertCurrent();
          }
          profileRespond(ok, ...response);
        }
      : profileRespond;
    respondCancelled = respondUnobserved;
    const respond: GatewayRequestOptions["respond"] = observation
      ? (...response) => {
          observationSignal?.throwIfAborted();
          respondUnobserved(...response);
          observationResponded = true;
        }
      : respondUnobserved;
    const sessionMutationCommitGuard =
      profileBinding || runtimeParticipant
        ? () => {
            profileBinding?.assertCurrent();
            runtimeParticipant?.assertCurrent();
            opts.sessionMutationCommitGuard?.();
          }
        : opts.sessionMutationCommitGuard;
    const entry = opts.requestEntry ?? context.requestEntryLifetime?.enter(opts);
    const releaseForegroundWork = retainSessionListForegroundWork();
    let sessionAccessAuthority: GatewaySessionAccessAuthority | undefined;
    try {
      entry?.assertOpen();
      const requestMutationAuthority = readGatewayRequestMutationAuthority(opts);
      const requestFacts = { method: req.method, requestParams: req.params, client, context };
      const authorization = await authorizeGatewayRequestPreDispatch({
        ...requestFacts,
        methodRegistry,
        expectedProfileBinding: profileBinding,
        hasCurrentClientAuthority,
        markSessionSubscribePhase: subscribeDiagnostics?.mark,
        assertInvocationCurrent: () => {
          runtimeParticipant?.assertCurrent();
          profileBinding?.assertCurrent();
          // Profile hydration binds the operator guard later; retain the original request lifetime.
          readGatewayRequestMutationAuthority(opts).assertOperatorCurrent?.();
          requestMutationAuthority.assertCurrent();
        },
      });
      sessionAccessAuthority = authorization.sessionAccessAuthority;
      entry?.assertOpen();
      if (authorization.error) {
        respond(false, undefined, authorization.error);
        return;
      }
      const handler = methodRegistry.getHandler(req.method) as GatewayRequestHandler | undefined;
      if (!handler) {
        const error = errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`);
        respond(false, undefined, error);
        return;
      }
      // Every session mutation owner uses these pre-commit assertions. Compose the
      // host lifetime here so individual handlers cannot lose it across an await.
      const assertOperatorCurrent = captureGatewayRequestOperatorGuard(opts);
      async function withSessionTurnAuthority<T>(
        target: { sessionKey: string; agentId?: string; sessionId: string },
        consume: (sessionEntry: InternalSessionEntry) => T,
      ): Promise<T> {
        let consumed: { value: T } | undefined;
        const turnAuthorization = await authorizeGatewayRequestPreDispatch({
          method: "chat.send",
          requestParams: { sessionKey: target.sessionKey, agentId: target.agentId },
          client,
          context,
          methodRegistry,
          expectedProfileBinding: profileBinding,
          hasCurrentClientAuthority,
          assertInvocationCurrent: () => {
            runtimeParticipant?.assertCurrent();
            assertOperatorCurrent();
            requestMutationAuthority.assertCurrent();
          },
          consumeSessionTurn: {
            target: { ...target },
            consume: (sessionEntry) => {
              const value = consume(sessionEntry);
              consumed = { value };
              return value;
            },
          },
        });
        if (turnAuthorization.error) {
          throw new SessionMutationAuthorizationChangedError(turnAuthorization.error);
        }
        if (!consumed) {
          throw new Error("Session turn authority was not consumed");
        }
        return consumed.value;
      }
      const sessionMutationAuthorization = withSessionMutationCommitGuard(
        authorization.sessionMutationAuthorization,
        () => {
          runtimeParticipant?.assertCurrent();
          assertOperatorCurrent();
          requestMutationAuthority.assertCurrent();
        },
        profileBinding?.assertCurrent,
        requestMutationAuthority.assertAdmittedInputCurrent
          ? () => {
              assertOperatorCurrent();
              requestMutationAuthority.assertAdmittedInputCurrent?.();
            }
          : undefined,
      );
      const respondAuthorized: GatewayRequestOptions["respond"] =
        authorization.sessionScope === "operator.sessions.read"
          ? (...response) => {
              try {
                sessionMutationAuthorization?.assertCurrent();
              } catch (error) {
                if (!(error instanceof SessionMutationAuthorizationChangedError)) {
                  throw error;
                }
                respond(false, undefined, error.error);
                return;
              }
              respond(...response);
            }
          : respond;
      const invokeHandler = async () => {
        retainRoot?.();
        subscribeDiagnostics?.mark("handlerPreparation");
        const preparedHandler = await prepareGatewayRequestHandler(handler, entry, opts);
        // Lazy preparation may yield across a hot config change. Keep the router fence
        // unless the canonical owner reconciles accepted input before new admission.
        const uploadError = gatewayRouterUploadPolicyError(requestFacts, methodRegistry);
        if (uploadError) {
          respond(false, undefined, uploadError);
          return;
        }
        const handlerOptions = bindGatewayRequestHandlerMutationAuthority(
          opts,
          {
            req,
            params: (req.params ?? {}) as Record<string, unknown>,
            client,
            isWebchatConnect,
            respond: respondAuthorized,
            acceptsSerializedJson: opts.acceptsSerializedJson,
            context,
            signal,
            ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
            sessionMutationCommitGuard,
            sessionMutationAuthorization,
            withSessionTurnAuthority,
            markSessionSubscribePhase: subscribeDiagnostics?.mark,
            ...(authorization.sessionAccessAuthority
              ? { sessionAccessAuthority: authorization.sessionAccessAuthority }
              : {}),
          },
          profileBinding,
          authorization.sessionScope,
        );
        sessionMutationCommitGuard?.();
        assertOperatorCurrent();
        authorization.sessionAccessAuthority?.assertCurrent();
        entry?.assertOpen();
        observationSignal?.throwIfAborted();
        if (signal?.aborted) {
          return;
        }
        // No await between the final fence, ownership handoff, and actual invocation.
        // Long polls and shutdown initiators must never remain preparation leases.
        entry?.release();
        profileBinding?.markInvoked();
        return GatewayRpcDiagnostics.runHandler(() => preparedHandler(handlerOptions), diagnostics);
      };
      if (req.method === "question.get" || req.method === "question.resolve") {
        // Draining admission consults the pending owner before handler entry.
        requestMutationAuthority.assertCurrent();
        profileBinding?.assertCurrent();
      }
      await runWithGatewayRequestEnvelope(req.method, client, invokeHandler, {
        context,
        isWebchatConnect,
        signal,
        hasCurrentClientAuthority,
        methodRegistry,
        requestParams: req.params,
        admission: opts.admission,
        reject: (error) => respond(false, undefined, error),
      });
    } catch (error) {
      if (error instanceof AgentDatabaseAdmissionError) {
        respond(false, undefined, errorShapeFromError(ErrorCodes.UNAVAILABLE, error));
        return;
      }
      if (!(error instanceof SessionMutationAuthorizationChangedError)) {
        throw error;
      }
      respond(false, undefined, error.error);
    } finally {
      sessionAccessAuthority?.release();
      releaseForegroundWork();
      // Transport/import owners retain failures through their response and logging paths.
      if (!opts.requestEntry) {
        entry?.release();
      }
    }
  };
  if (!observation) {
    return await dispatch();
  }
  await runWithGatewayObservationScope(
    req.method,
    dispatch,
    [signal, client?.connectionSignal],
    (error) => {
      if (!observationResponded && !client?.connectionSignal?.aborted) {
        respondCancelled(false, undefined, error);
      }
    },
  );
}
