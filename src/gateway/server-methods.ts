import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_RESTART_UNAVAILABLE_REASON,
  GATEWAY_SUSPEND_UNAVAILABLE_REASON,
} from "../../packages/gateway-protocol/src/restart-unavailable.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { withCanonicalSessionValidationDeferral } from "../config/sessions/session-canonical-validation-deferral.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  getPluginRuntimeGatewayNodeAuthorities,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { SessionOperatorScope } from "../shared/session-method-scopes-base.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import {
  consumeControlPlaneWriteBudget,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
} from "./control-plane-rate-limit.js";
import { createExpectedProfileBinding, type ExpectedProfileBinding } from "./expected-profile.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import { canSelectQuestion } from "./question-access.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import { authorizeAuthenticatedProfileForMethod } from "./server-methods/gateway-client-identity.js";
import { prepareGatewayRequestHandler } from "./server-methods/lazy-core-handlers.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { isTargetedNonSafeGatewayRestartRequest } from "./server-methods/restart-request.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  captureGatewayRequestOperatorGuard,
  readGatewayRequestMutationAuthority,
  withSessionMutationCommitGuard,
} from "./server-methods/session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import type { GatewayRequestEntry } from "./server-request-entry.js";
import type { GatewayRpcDiagnostics } from "./server/ws-connection/request-diagnostics.js";
import {
  prepareGatewaySessionAccessAuthority,
  type GatewaySessionAccessAuthority,
} from "./session-access-authority.js";
import { sessionMutationTargetFields } from "./session-method-policy.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
} from "./session-sharing-target-input.js";
import {
  isGatewayAdmin,
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import { classifyGatewayStaleInstall } from "./stale-install.js";

export { coreGatewayHandlers };

const SUSPEND_CONTROL_METHODS = new Set([
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
  "gateway.suspend.handoff",
]);

function runGatewayPendingWorkContinuation<T>(params: {
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

/** Builds the per-request method registry from core, plugin, and explicit extra handlers. */
export function createRequestGatewayMethodRegistry(
  extraHandlers?: GatewayRequestHandlers,
): GatewayMethodRegistry {
  // Attached gateway methods must not be shadowed by agent-scoped registry loads.
  const gatewayPluginRegistry = getActivePluginRegistry();
  const gatewayPluginHandlers = gatewayPluginRegistry?.gatewayHandlers ?? {};
  const extraHandlerEntries = Object.entries(extraHandlers ?? {});
  const pluginMethodNames = new Set(Object.keys(gatewayPluginHandlers));
  const coreDescriptorHandlers = { ...coreGatewayHandlers };
  for (const [method, extraHandler] of extraHandlerEntries) {
    // Tests and local harnesses can override classified core methods, but plugin-provided
    // methods win so a loaded plugin cannot be shadowed by a caller-local extra handler.
    if (!pluginMethodNames.has(method) && isCoreGatewayMethodClassified(method)) {
      coreDescriptorHandlers[method] = extraHandler;
    }
  }
  const auxHandlers = Object.fromEntries(
    extraHandlerEntries.filter(
      ([method]) => !pluginMethodNames.has(method) && !isCoreGatewayMethodClassified(method),
    ),
  );
  return createGatewayMethodRegistry(
    [
      ...createCoreGatewayMethodDescriptors(coreDescriptorHandlers),
      ...(gatewayPluginRegistry ? createPluginGatewayMethodDescriptors(gatewayPluginRegistry) : []),
      ...createGatewayMethodDescriptorsFromHandlers({
        handlers: auxHandlers,
        owner: { kind: "aux", area: "gateway-extra" },
        defaultScope: ADMIN_SCOPE,
      }),
    ],
    gatewayPluginRegistry ?? undefined,
  );
}

/** Applies the router-owned authorization fence before any transport or typed dispatch. */
export async function authorizeGatewayRequestPreDispatch(params: {
  method: string;
  requestParams: unknown;
  client: GatewayRequestOptions["client"];
  context: GatewayRequestContext;
  methodRegistry: GatewayMethodRegistry;
  expectedProfileBinding?: ExpectedProfileBinding;
  hasCurrentClientAuthority?: () => boolean;
  assertInvocationCurrent?: () => void;
}): Promise<{
  error: ErrorShape | null;
  sessionScope?: SessionOperatorScope;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  sessionAccessAuthority?: GatewaySessionAccessAuthority;
}> {
  if (params.context.ensureSessionRowProjection) {
    await params.context.ensureSessionRowProjection();
  }
  const authorizeMethod = () =>
    withPluginRuntimeRegistryScope(
      // SAFETY: The host-owned method registry carries the PluginRegistry selected for dispatch.
      params.methodRegistry.pluginRegistry as PluginRegistry | undefined,
      () =>
        authorizeGatewayMethod(
          params.method,
          params.client,
          params.requestParams,
          params.methodRegistry,
          params.context,
        ),
    );
  while (true) {
    const scopeAuthorization = authorizeMethod();
    if (scopeAuthorization.error) {
      return { error: scopeAuthorization.error };
    }
    // GitHub-backed connections receive hello before remote account resolution. Profile-owned
    // methods must cross this single router fence before session authorization or handler work.
    const profileError = await authorizeAuthenticatedProfileForMethod({
      client: params.client,
      sessionScope: scopeAuthorization.sessionScope,
      requiresProfile: () =>
        params.expectedProfileBinding !== undefined ||
        params.methodRegistry.requiresAuthenticatedProfile(params.method) ||
        resolveDirectIncognitoTargets(params.method, params.requestParams).length > 0 ||
        (sessionMutationTargetFields(params.method).length > 0 &&
          (params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig)().gateway
            ?.roles !== undefined),
    });
    if (profileError) {
      return { error: profileError };
    }
    try {
      params.expectedProfileBinding?.assertCurrent();
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return { error: error.error };
      }
      throw error;
    }
    // Startup gating precedes session authorization: session stores are not loaded yet,
    // so an authorization read here would deny with a misleading non-retryable error.
    if (params.context.unavailableGatewayMethods?.has(params.method)) {
      return {
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `${params.method} unavailable during gateway startup`,
          {
            retryable: true,
            retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
            details: { ...gatewayStartupUnavailableDetails(), method: params.method },
          },
        ),
      };
    }
    if (params.method.startsWith("sessions.groups.")) {
      const { ensureSessionGroupCatalog } = await import("./session-group-catalog.js");
      await ensureSessionGroupCatalog();
      const groupProjection = getSessionRowProjection(params.context);
      if (groupProjection) {
        do {
          await groupProjection.prepareMembership();
        } while (groupProjection.needsMembershipPreparation());
      }
      params.expectedProfileBinding?.assertCurrent();
    }
    const sessionPolicy = params.methodRegistry.getSessionAccess?.(params.method);
    const projection =
      params.method === "sessions.describe" && !isGatewayAdmin(params.client)
        ? getSessionRowProjection(params.context)
        : undefined;
    const authorizeSession = (sessionRowRead?: SessionRowReadView) =>
      sessionPolicy
        ? { error: null }
        : resolveSessionMutationAuthorization({
            client: params.client ?? null,
            method: params.method,
            requestParams: params.requestParams,
            context: params.context,
            sessionRowRead,
            sessionScope: scopeAuthorization.sessionScope,
          });
    const preparedSessionMutation = projection
      ? await projection.withPreparedExactRows(
          (cfg) =>
            resolveDirectSessionTargets(params.method, params.requestParams).flatMap((target) => {
              const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
              return agent.ok ? [{ key: target.sessionKey, agentId: agent.agentId }] : [];
            }),
          authorizeSession,
        )
      : withCanonicalSessionValidationDeferral(() => authorizeSession());
    if (preparedSessionMutation.kind === "pending") {
      const { certifySessionCanonicalValidationPending } =
        await import("../config/sessions/session-canonical-validation-readiness.js");
      await certifySessionCanonicalValidationPending(preparedSessionMutation.database);
      // No permission result survives readiness. Method scopes, profile binding,
      // startup state, target selection and current session facts all run again.
      continue;
    }
    const sessionMutation = preparedSessionMutation.value;
    if (sessionMutation.error) {
      return { error: sessionMutation.error };
    }
    let sessionAccessAuthority: GatewaySessionAccessAuthority | undefined;
    if (sessionPolicy) {
      try {
        sessionAccessAuthority = await prepareGatewaySessionAccessAuthority({
          policy: sessionPolicy,
          requestParams: params.requestParams,
          client: params.client ?? null,
          context: params.context,
          ownSessionOnly: scopeAuthorization.sessionScope === "operator.sessions.write",
          hasCurrentClientAuthority: params.hasCurrentClientAuthority,
          assertInvocationCurrent: params.assertInvocationCurrent,
        });
        params.expectedProfileBinding?.assertCurrent();
        sessionAccessAuthority.assertCurrent();
      } catch (error) {
        sessionAccessAuthority?.release();
        if (error instanceof SessionMutationAuthorizationChangedError) {
          return { error: error.error };
        }
        throw error;
      }
    }
    if (
      params.client?.connect.role === "node" &&
      (!params.client.connId ||
        !(await params.context.nodeRegistry.isConnectionCurrentPairingState(params.client.connId)))
    ) {
      return {
        error: errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed before request dispatch", {
          retryable: true,
          details: { code: "PAIRING_CHANGED" },
        }),
      };
    }
    const currentAuthorization = authorizeMethod();
    if (currentAuthorization.error) {
      sessionAccessAuthority?.release();
      return { error: currentAuthorization.error };
    }
    if (currentAuthorization.sessionScope !== scopeAuthorization.sessionScope) {
      sessionAccessAuthority?.release();
      return { error: errorShape(ErrorCodes.FORBIDDEN, "Gateway requester authority changed") };
    }
    return {
      error: null,
      sessionScope: scopeAuthorization.sessionScope,
      ...(sessionAccessAuthority ? { sessionAccessAuthority } : {}),
      ...(sessionMutation.authorization
        ? { sessionMutationAuthorization: sessionMutation.authorization }
        : {}),
    };
  }
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
  const restartProgressRead =
    method === "update.runs.get" &&
    getGatewayRestartDrainSignal().aborted &&
    getGatewaySuspendAdmissionPhase() === "accepting";
  if (!rootWorkAdmission && !SUSPEND_CONTROL_METHODS.has(method) && !restartProgressRead) {
    const restartDraining = isGatewayRestartDraining();
    return await options.reject(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `${method} unavailable during gateway ${restartDraining ? "restart" : "suspension"}`,
        {
          retryable: true,
          retryAfterMs: 1_000,
          details: {
            method,
            reason: restartDraining
              ? GATEWAY_RESTART_UNAVAILABLE_REASON
              : GATEWAY_SUSPEND_UNAVAILABLE_REASON,
            phase: getGatewaySuspendAdmissionPhase(),
          },
        },
      ),
    );
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
  const respond =
    profileBinding && !opts.expectedProfileBinding
      ? profileBinding.guardResponse(opts.respond)
      : opts.respond;
  const sessionMutationCommitGuard = profileBinding
    ? () => {
        profileBinding.assertCurrent();
        opts.sessionMutationCommitGuard?.();
      }
    : opts.sessionMutationCommitGuard;
  const entry = opts.requestEntry ?? context.requestEntryLifetime?.enter(opts);
  const releaseForegroundWork = retainSessionListForegroundWork();
  let sessionAccessAuthority: GatewaySessionAccessAuthority | undefined;
  try {
    entry?.assertOpen();
    // Prefer the caller-attached registry when it owns the requested method so plugin dispatch
    // metadata newer than global runtime state still authorizes and dispatches correctly. When the
    // attached snapshot does not own the method, rebuild from the process-root registry so late
    // methods remain reachable (#94127).
    const methodRegistry =
      opts.methodRegistry?.getHandler(req.method) !== undefined
        ? opts.methodRegistry
        : createRequestGatewayMethodRegistry(opts.extraHandlers);
    const requestMutationAuthority = readGatewayRequestMutationAuthority(opts);
    const authorization = await authorizeGatewayRequestPreDispatch({
      method: req.method,
      requestParams: req.params,
      client,
      context,
      methodRegistry,
      expectedProfileBinding: profileBinding,
      hasCurrentClientAuthority,
      assertInvocationCurrent: () => {
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
    const sessionMutationAuthorization = withSessionMutationCommitGuard(
      authorization.sessionMutationAuthorization,
      () => {
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
    const respondToHandler: GatewayRequestOptions["respond"] =
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
      const preparedHandler = await prepareGatewayRequestHandler(handler, entry);
      const handlerOptions = bindGatewayRequestHandlerMutationAuthority(
        opts,
        {
          req,
          params: (req.params ?? {}) as Record<string, unknown>,
          client,
          isWebchatConnect,
          respond: respondToHandler,
          context,
          signal,
          ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
          sessionMutationCommitGuard,
          sessionMutationAuthorization,
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
      if (signal?.aborted) {
        return;
      }
      // No await between the final fence, ownership handoff, and actual invocation.
      // Long polls and shutdown initiators must never remain preparation leases.
      entry?.release();
      profileBinding?.markInvoked();
      return diagnostics
        ? diagnostics.runHandler(() => preparedHandler(handlerOptions))
        : preparedHandler(handlerOptions);
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
  } finally {
    sessionAccessAuthority?.release();
    releaseForegroundWork();
    // Transport/import owners retain failures through their response and logging paths.
    if (!opts.requestEntry) {
      entry?.release();
    }
  }
}
