import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type {
  ConnectParams,
  ErrorShape,
  ResponseFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateRequestFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import {
  createChildDiagnosticTraceContext,
  parseDiagnosticTraceparent,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { runOutsideGatewayRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createLazyPromise } from "../../../shared/lazy-runtime.js";
import { isGatewayAuthPolicyCurrent } from "../../auth-policy.js";
import { captureGatewayDeviceRevocation } from "../../device-revocation.js";
import { createExpectedProfileBinding } from "../../expected-profile.js";
import {
  GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
  hasCurrentGatewayOperatorAccess,
} from "../../operator-access-policy.js";
import { onOperatorRolePolicyChanged } from "../../operator-role-policy.js";
import { bindWebSocketRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestEntry } from "../../server-request-entry.js";
import { SharedGatewaySessionGenerationState } from "../../server-shared-auth-generation.js";
import { classifyGatewayStaleInstall } from "../../stale-install.js";
import { formatForLog, logWs } from "../../ws-log.js";
import {
  hasCurrentGatewayPolicyClientSource,
  invalidateGatewayPolicyClient,
  onGatewayPolicyClientInvalidated,
  registerGatewayPolicyResponse,
} from "../ws-policy-close.js";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";
import { createGatewayRpcDiagnostics } from "./request-diagnostics.js";
import { scheduleGatewayRequestStart } from "./request-start.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

const loadGatewayServerMethods = createLazyPromise(
  () => import("./authenticated-request-dispatch.server-methods.runtime.js"),
);

const DEVICE_CREDENTIAL_INVALIDATING_METHODS = new Set([
  "device.pair.remove",
  "device.token.rotate",
  "device.token.revoke",
  "node.pair.remove",
]);

export function createGatewayAuthenticatedRequestDispatcher(params: {
  handler: GatewayWsMessageHandlerParams;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
}) {
  const {
    connId,
    clients,
    getRequiredSharedGatewaySessionGeneration,
    extraHandlers,
    getMethodRegistry,
    buildRequestContext,
    send,
    close,
    isClosed,
    setCloseCause,
    logGateway,
  } = params.handler;
  const unauthorizedFloodGuard = new UnauthorizedFloodGuard();
  let deviceCredentialMutationBarrier: Promise<void> | undefined;

  const closeInvalidatedClient = (client: GatewayWsClient, method: string): boolean => {
    const policyChanged = !isGatewayAuthPolicyCurrent(client.authPolicyGeneration);
    if (!client.invalidated && !policyChanged) {
      return false;
    }
    const reason =
      client.invalidatedReason ?? (policyChanged ? "gateway-policy-changed" : "invalidated");
    setCloseCause("client-invalidated", {
      reason,
      method,
    });
    invalidateGatewayPolicyClient(client, {
      reason,
      code: 4001,
      message: `client invalidated: ${reason}`,
      close: () => close(4001, `client invalidated: ${reason}`),
      // The mutation owner already decided whether this was a committed revocation.
      revokeSource: false,
    });
    return true;
  };

  const dispatch = async (
    parsed: unknown,
    client: GatewayWsClient,
    frameBytes: number,
    admission?: "continuation",
    sendResponse: (frame: ResponseFrame) => ReturnType<typeof send> = send,
  ): Promise<void> => {
    // After handshake, accept only req frames
    if (!validateRequestFrame(parsed)) {
      send({
        type: "res",
        id: (parsed as { id?: unknown })?.id ?? "invalid",
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
        ),
      });
      return;
    }
    const req = parsed;
    if (closeInvalidatedClient(client, req.method)) {
      return;
    }
    const diagnostics = createGatewayRpcDiagnostics(req.method, getMethodRegistry, extraHandlers);
    logWs("in", "req", { connId, id: req.id, method: req.method });
    const context = buildRequestContext();
    const generationState = SharedGatewaySessionGenerationState.fromReader(
      getRequiredSharedGatewaySessionGeneration,
    );
    const sourceContext = context.resolveGatewayContext?.() ?? context;
    const isCommittedPolicyCurrent = () =>
      client.authPolicyGeneration === undefined ||
      isGatewayAuthPolicyCurrent(
        client.authPolicyGeneration,
        sourceContext.getCommittedRuntimeConfig?.() ?? sourceContext.getRuntimeConfig(),
      );
    const clientAuthority = captureGatewayDeviceRevocation(
      context,
      { deviceId: client.connect.device?.id, role: client.connect.role },
      () => {
        if (!hasCurrentGatewayOperatorAccess(client.internal?.operatorAccessAuthority)) {
          invalidateGatewayPolicyClient(client, {
            reason: "operator-access-closed",
            code: 4001,
            message: GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
            close: () => close(4001, GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE),
          });
        }
        if (closeInvalidatedClient(client, req.method)) {
          return false;
        }
        const requiredGeneration = client.usesSharedGatewayAuth
          ? getRequiredSharedGatewaySessionGeneration?.()
          : undefined;
        if (
          requiredGeneration !== undefined &&
          client.sharedGatewaySessionGeneration !== requiredGeneration
        ) {
          setCloseCause("gateway-auth-rotated", { authGenerationStale: true, method: req.method });
          invalidateGatewayPolicyClient(client, {
            reason: "gateway-auth-changed",
            code: 4001,
            message: "gateway auth changed",
            close: () => close(4001, "gateway auth changed"),
            revokeSource: false,
          });
          return false;
        }
        return true;
      },
      client.connectionSignal,
      client.connect.role === "operator" && (!client.usesSharedGatewayAuth || generationState)
        ? {
            isCurrent: () =>
              hasCurrentGatewayPolicyClientSource(client) && isCommittedPolicyCurrent(),
            subscribe: (onRevoked) => {
              const releaseClient = onGatewayPolicyClientInvalidated(client, onRevoked);
              const releasePolicy = onOperatorRolePolicyChanged((change) => {
                if (
                  change.kind === "config" &&
                  change.context === sourceContext &&
                  !isCommittedPolicyCurrent()
                ) {
                  onRevoked();
                }
              });
              const releaseGeneration = client.usesSharedGatewayAuth
                ? generationState?.onInvalidated(client.sharedGatewaySessionGeneration, onRevoked)
                : undefined;
              return () => {
                releaseClient();
                releasePolicy();
                releaseGeneration?.();
              };
            },
          }
        : undefined,
    );
    const hasCurrentClientAuthority = clientAuthority.isCurrent;
    // Origin/profile policy still enumerates clients; keep this invocation visible
    // after transport closure without adding it to presence or message fanout.
    const releaseAuthority = clients.retainRequest(client);
    // Reserve receipt order before profile preparation can yield. A failed middle
    // request must still carry the unfinished predecessor for later frames.
    const credentialMutationBarrier = deviceCredentialMutationBarrier;
    const mutationCompletion = DEVICE_CREDENTIAL_INVALIDATING_METHODS.has(req.method)
      ? createDeferredCore()
      : undefined;
    if (mutationCompletion) {
      const barrier = Promise.allSettled([
        credentialMutationBarrier,
        mutationCompletion.promise,
      ]).then(() => {
        if (deviceCredentialMutationBarrier === barrier) {
          deviceCredentialMutationBarrier = undefined;
        }
      });
      deviceCredentialMutationBarrier = barrier;
    }
    try {
      const expectedProfileBinding =
        req.expectedProfileId === undefined
          ? undefined
          : await createExpectedProfileBinding(req.expectedProfileId, client, () => {
              if (!hasCurrentClientAuthority()) {
                throw new Error("Gateway requester authority changed");
              }
            });
      const publishResponse = (
        ok: boolean,
        payload?: unknown,
        error?: ErrorShape,
        meta?: Record<string, unknown>,
      ) => {
        if (!policyResponse?.pending && !hasCurrentClientAuthority()) {
          diagnostics?.response("suppressed");
          return;
        }
        try {
          let responseOk = ok;
          let responseError = error;
          let sendResult = sendResponse({ type: "res", id: req.id, ok, payload, error });
          if (sendResult.kind === "serialization") {
            const detail = formatForLog(sendResult.error);
            logGateway.error(`response serialization failed method=${req.method}: ${detail}`);
            responseOk = false;
            responseError = errorShape(ErrorCodes.UNAVAILABLE, "response serialization failed");
            sendResult = sendResponse({
              type: "res",
              id: req.id,
              ok: responseOk,
              error: responseError,
            });
          }
          diagnostics?.response(
            sendResult.kind === "sent" ? (responseOk ? "ok" : "error") : "unavailable",
          );
          const unauthorizedRoleError = isUnauthorizedRoleError(responseError);
          let logMeta = meta;
          if (unauthorizedRoleError) {
            const unauthorizedDecision = unauthorizedFloodGuard.registerUnauthorized();
            if (unauthorizedDecision.suppressedSinceLastLog > 0) {
              logMeta = {
                ...logMeta,
                suppressedUnauthorizedResponses: unauthorizedDecision.suppressedSinceLastLog,
              };
            }
            if (!unauthorizedDecision.shouldLog) {
              return;
            }
            if (unauthorizedDecision.shouldClose) {
              setCloseCause("repeated-unauthorized-requests", {
                unauthorizedCount: unauthorizedDecision.count,
                method: req.method,
              });
              queueMicrotask(() => close(1008, "repeated unauthorized calls"));
            }
            logMeta = {
              ...logMeta,
              unauthorizedCount: unauthorizedDecision.count,
            };
          } else {
            unauthorizedFloodGuard.reset();
          }
          logWs("out", "res", {
            connId,
            id: req.id,
            ok: responseOk,
            method: req.method,
            errorCode: responseError?.code,
            errorMessage: responseError?.message,
            ...logMeta,
          });
        } finally {
          // ws queues frames in order: send the result before starting its close handshake.
          policyResponse?.finish();
        }
      };

      const respond = expectedProfileBinding?.guardResponse(publishResponse) ?? publishResponse;
      const agentRuntimeIdentity = client.internal?.agentRuntimeIdentity;
      const hasCurrentRuntimeAuthority = () => {
        if (
          agentRuntimeIdentity &&
          context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) !== true
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
          );
          setCloseCause("agent-runtime-authority-closed", { method: req.method });
          close(4001, "agent runtime authority closed");
          return false;
        }
        return true;
      };
      const respondWithAuthority: typeof respond = (ok, payload, error, meta) => {
        if (hasCurrentRuntimeAuthority()) {
          respond(ok, payload, error, meta);
        }
      };
      const policyResponse = registerGatewayPolicyResponse(
        req.method,
        client,
        respondWithAuthority,
      );

      const executeRequest = async () => {
        diagnostics?.bindTrace();
        let entry: GatewayRequestEntry | undefined;
        // Most UI/SDK RPCs outlive a reconnect. Companion asks are the exception:
        // without their requester there is no safe recipient for a late answer.
        const cancelOnDisconnect =
          req.method === "sessions.companion.ask" ||
          (req.method === "node.invoke" &&
            client.connect.client.id === GATEWAY_CLIENT_IDS.CLI &&
            client.connect.client.mode === GATEWAY_CLIENT_MODES.CLI);
        const requestController = cancelOnDisconnect ? new AbortController() : undefined;
        const accessSignal = client.internal?.operatorAccessAuthority?.signal;
        const signal = requestController
          ? accessSignal
            ? AbortSignal.any([requestController.signal, accessSignal])
            : requestController.signal
          : accessSignal;
        const cancelRequest = () => requestController?.abort();
        if (requestController) {
          client.socket.once("close", cancelRequest);
        }
        let dispatchOutcome: "returned" | "threw" = "returned";
        try {
          entry = context.requestEntryLifetime?.enter({ req, client, context });
          if (credentialMutationBarrier) {
            await racePromiseWithAbortSignal(
              credentialMutationBarrier,
              context.requestEntryLifetime?.signal,
            ).catch(() => undefined);
            // Refuse within the preparation lease so its response settles before the
            // preparation join; the mutating handler retains its execution owner.
            if (context.requestEntryLifetime?.signal.aborted) {
              respondWithAuthority(
                false,
                undefined,
                errorShape(ErrorCodes.UNAVAILABLE, "gateway closing before request dispatch", {
                  retryable: true,
                }),
              );
              return;
            }
            if (isClosed()) {
              return;
            }
          }
          if (!hasCurrentClientAuthority() || !hasCurrentRuntimeAuthority()) {
            return;
          }
          const { handleGatewayRequest } = await loadGatewayServerMethods();
          entry?.assertOpen();
          // Node completion traffic retains its native yielding and existing close-drain
          // deadline. Operator requests share bounded starts without serializing completion.
          if (client.connect.role === "operator") {
            diagnostics?.startQueue();
            const start = scheduleGatewayRequestStart(frameBytes);
            if (!start) {
              respondWithAuthority(
                false,
                undefined,
                errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "The server is busy. Please try again in a moment.",
                  {
                    retryable: true,
                  },
                ),
              );
              return;
            }
            await start;
            diagnostics?.finishQueue();
          }
          entry?.assertOpen();
          // Waiting never grants authority. Ordinary requests may outlive their socket;
          // only request-owned cancellation and current authority fence their start.
          if (signal?.aborted || !hasCurrentClientAuthority() || !hasCurrentRuntimeAuthority()) {
            return;
          }
          await runOutsideGatewayRootWorkAdmission(() =>
            handleGatewayRequest(
              bindWebSocketRequestMutationAuthority(
                {
                  req,
                  respond: respondWithAuthority,
                  client,
                  isWebchatConnect: params.isWebchatConnect,
                  hasCurrentClientAuthority,
                  expectedProfileBinding,
                  extraHandlers,
                  methodRegistry: getMethodRegistry?.(),
                  context,
                  ...(admission ? { admission } : {}),
                  requestEntry: entry,
                  ...(signal ? { signal } : {}),
                },
                client,
                getRequiredSharedGatewaySessionGeneration,
              ),
              diagnostics,
            ),
          );
        } catch (err) {
          dispatchOutcome = "threw";
          // Failure diagnostics and responses belong to the same request trace as the handler.
          logGateway.error(`request handler failed: ${formatForLog(err)}`);
          const staleInstall = classifyGatewayStaleInstall(err);
          respondWithAuthority(
            false,
            undefined,
            staleInstall?.error ?? errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
          );
        } finally {
          policyResponse?.finish();
          diagnostics?.finish(signal?.aborted ? "cancelled" : dispatchOutcome);
          entry?.release();
          if (requestController) {
            client.socket.off("close", cancelRequest);
          }
        }
      };
      const upstreamTrace = parseDiagnosticTraceparent(req.traceparent);
      const dispatchRequest = () =>
        upstreamTrace
          ? runWithDiagnosticTraceContext(
              createChildDiagnosticTraceContext(upstreamTrace),
              executeRequest,
            )
          : executeRequest();
      const requestDispatch =
        client.connect.role === "node"
          ? params.handler.nodeLifecycleDispatch.dispatch(req.method, dispatchRequest)
          : dispatchRequest();
      await requestDispatch;
    } finally {
      try {
        releaseAuthority();
      } finally {
        try {
          clientAuthority.release();
        } finally {
          mutationCompletion?.resolve();
        }
      }
    }
  };

  return { dispatch };
}
