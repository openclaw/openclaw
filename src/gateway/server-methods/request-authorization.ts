import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { withCanonicalSessionValidationDeferral } from "../../config/sessions/session-canonical-validation-deferral.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import type { ExpectedProfileBinding } from "../expected-profile.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import {
  prepareGatewaySessionAccessAuthority,
  type GatewaySessionAccessAuthority,
} from "../session-access-authority.js";
import { sessionMutationTargetFields } from "../session-method-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { SessionRowReadView } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
} from "../session-sharing-target-input.js";
import {
  isGatewayAdmin,
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { SessionSubscribePhase } from "../slow-request-diagnostics.js";
import { gatewayRouterUploadPolicyError } from "./core-handlers.js";
import { authorizeAuthenticatedProfileForMethod } from "./gateway-client-identity.js";
import { authorizeGatewayMethod } from "./method-authorization.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./types.js";

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
  markSessionSubscribePhase?: (phase: SessionSubscribePhase) => void;
  consumeSessionTurn?: {
    target: { sessionKey: string; agentId?: string; sessionId: string };
    consume: (entry: InternalSessionEntry) => unknown;
  };
}): Promise<{
  error: ErrorShape | null;
  sessionScope?: SessionOperatorScope;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  sessionAccessAuthority?: GatewaySessionAccessAuthority;
}> {
  const signal = params.methodRegistry.isObservation(params.method)
    ? getAsyncWorkSignal()
    : undefined;
  signal?.throwIfAborted();
  if (params.context.ensureSessionRowProjection) {
    params.markSessionSubscribePhase?.("projectionReadiness");
    await params.context.ensureSessionRowProjection();
  }
  params.markSessionSubscribePhase?.("accessFacts");
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
  const startupError = () =>
    params.context.unavailableGatewayMethods?.has(params.method)
      ? errorShape(ErrorCodes.UNAVAILABLE, `${params.method} unavailable during gateway startup`, {
          retryable: true,
          retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
          details: { ...gatewayStartupUnavailableDetails(), method: params.method },
        })
      : null;
  while (true) {
    signal?.throwIfAborted();
    const scopeAuthorization = authorizeMethod();
    if (scopeAuthorization.error) {
      return { error: scopeAuthorization.error };
    }
    const uploadError = gatewayRouterUploadPolicyError(params, params.methodRegistry);
    if (uploadError) {
      return { error: uploadError };
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
    const unavailableError = startupError();
    if (unavailableError) {
      return { error: unavailableError };
    }
    if (params.method.startsWith("sessions.groups.")) {
      const { ensureSessionGroupCatalog } = await import("../session-group-catalog.js");
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
    if (params.consumeSessionTurn && (params.method !== "chat.send" || sessionPolicy)) {
      throw new Error("Session turn consumers require core chat.send admission");
    }
    const projection =
      !sessionPolicy &&
      resolveDirectSessionTargets(params.method, params.requestParams).length > 0 &&
      (params.consumeSessionTurn || !isGatewayAdmin(params.client))
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
    const authorizeSessionAndConsume = params.consumeSessionTurn
      ? (sessionRowRead?: SessionRowReadView) => {
          // Consume transient incognito rows before their prepared view closes.
          const currentAuthorization = authorizeMethod();
          const currentError = currentAuthorization.error ?? startupError();
          if (currentError) {
            return { error: currentError };
          }
          try {
            params.expectedProfileBinding?.assertCurrent();
            params.assertInvocationCurrent?.();
          } catch (error) {
            if (error instanceof SessionMutationAuthorizationChangedError) {
              return { error: error.error };
            }
            throw error;
          }
          if (currentAuthorization.sessionScope !== scopeAuthorization.sessionScope) {
            return {
              error: errorShape(ErrorCodes.FORBIDDEN, "Gateway requester authority changed"),
            };
          }
          if (!sessionRowRead) {
            return { error: errorShape(ErrorCodes.UNAVAILABLE, "Session facts are unavailable") };
          }
          const result = authorizeSession(sessionRowRead);
          if (result.error) {
            return result;
          }
          const { target, consume } = params.consumeSessionTurn!;
          const admitted = result.authorization?.admittedTarget;
          const row =
            admitted &&
            sessionRowRead.describe({
              key: admitted.sessionKey,
              agentId: admitted.agentId,
            });
          if (
            !admitted ||
            admitted.sessionId !== target.sessionId ||
            admitted.sessionKey !== target.sessionKey ||
            (target.agentId !== undefined && admitted.agentId !== target.agentId) ||
            row?.storedEntry?.sessionId !== target.sessionId
          ) {
            return { error: errorShape(ErrorCodes.FORBIDDEN, "Session changed before file read") };
          }
          const value = consume(row.storedEntry);
          if (isPromiseLike(value)) {
            void Promise.resolve(value).catch(() => {});
            throw new Error("Session turn authority consumers must remain synchronous");
          }
          return result;
        }
      : authorizeSession;
    const subscriptionAccessOnly =
      params.method === "sessions.messages.subscribe" &&
      resolveDirectIncognitoTargets(params.method, params.requestParams).length === 0;
    if (projection && subscriptionAccessOnly) {
      // Observers need committed sharing facts, not display rows held by an active turn's
      // worker refresh. Incognito reads keep their transient exact-row preparation.
      params.markSessionSubscribePhase?.("accessFacts");
      while (projection.needsMembershipPreparation()) {
        await projection.prepareMembership();
      }
    }
    params.markSessionSubscribePhase?.(
      subscriptionAccessOnly ? "accessFacts" : "projectionReadiness",
    );
    const preparedSessionMutation =
      projection && !subscriptionAccessOnly
        ? await projection.withPreparedExactRows((cfg) => {
            signal?.throwIfAborted();
            return resolveDirectSessionTargets(params.method, params.requestParams).flatMap(
              (target) => {
                const agent = resolveRequestedSessionAgentId(
                  cfg,
                  target.sessionKey,
                  target.agentId,
                );
                return agent.ok ? [{ key: target.sessionKey, agentId: agent.agentId }] : [];
              },
            );
          }, authorizeSessionAndConsume)
        : withCanonicalSessionValidationDeferral(() => authorizeSessionAndConsume());
    params.markSessionSubscribePhase?.("accessFacts");
    signal?.throwIfAborted();
    if (preparedSessionMutation.kind === "pending") {
      const { certifySessionCanonicalValidationPending } =
        await import("../../config/sessions/session-canonical-validation-readiness.js");
      signal?.throwIfAborted();
      await certifySessionCanonicalValidationPending(preparedSessionMutation.database);
      // No permission result survives readiness. Method scopes, profile binding,
      // startup state, target selection and current session facts all run again.
      continue;
    }
    const sessionMutation = preparedSessionMutation.value;
    if (sessionMutation.error) {
      return { error: sessionMutation.error };
    }
    if (params.consumeSessionTurn) {
      return { error: null, sessionScope: scopeAuthorization.sessionScope };
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
    const currentError = currentAuthorization.error ?? startupError();
    if (currentError) {
      sessionAccessAuthority?.release();
      return { error: currentError };
    }
    try {
      params.expectedProfileBinding?.assertCurrent();
    } catch (error) {
      sessionAccessAuthority?.release();
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return { error: error.error };
      }
      throw error;
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
