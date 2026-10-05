import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSuggestionEvent,
  type SessionSuggestionResolution,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveSessionWorkStartError,
  SessionWorkStartInvalidatedError,
  isSessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import { hasOperatorBoundary, operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "../session-sharing-preparation.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  prepareProjectedSessionSharing,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

function canSeeSuggestionTarget(params: {
  client: GatewayClient | null;
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  sharing?: ReturnType<typeof prepareProjectedSessionSharing>;
}): boolean {
  return (
    !hasOperatorBoundary(params.client, params.cfg) ||
    (
      params.sharing?.entryFilter ??
      createSessionListEntryFilter({ client: params.client, cfg: params.cfg })
    )?.(params.target.storeKey, params.target.entry) !== false
  );
}

export function requireSuggestionTarget(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
  respond: RespondFn;
}) {
  const cfg = params.context.getRuntimeConfig();
  const policyConfig = params.context.getCommittedRuntimeConfig?.() ?? cfg;
  const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return null;
  }
  const target = resolveSessionSharingTarget({
    cfg,
    sessionKey: params.sessionKey,
    agentId: requestedAgent.agentId,
  });
  if (!target || !canSeeSuggestionTarget({ client: params.client, cfg: policyConfig, target })) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  return target;
}

export function requireVisibleSuggestionRole(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  sessionKey: string;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  respond: RespondFn;
  sharing?: ReturnType<typeof prepareProjectedSessionSharing>;
}) {
  const role =
    params.sharing?.roleForTarget(params.target) ??
    resolveSessionSharingRole({
      client: params.client,
      cfg: params.cfg,
      target: params.target,
    });
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  if (incognitoError) {
    params.respond(false, undefined, incognitoError);
    return null;
  }
  if (resolveSessionVisibility(params.target.entry) !== "draft") {
    return role;
  }
  const error = params.sharing
    ? params.sharing.authorizeTarget(params.target)
    : authorizeSessionSharingTarget({
        client: params.client,
        cfg: params.cfg,
        target: params.target,
      });
  if (!error) {
    return role;
  }
  params.respond(false, undefined, error);
  return null;
}

export function authorizeSessionSuggestionMutation(
  params: Parameters<typeof requireVisibleSuggestionRole>[0],
  action: "add" | SessionSuggestionResolution,
): boolean {
  const { cfg, client, target, respond } = params;
  if (!canSeeSuggestionTarget(params)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return false;
  }
  const role = requireVisibleSuggestionRole(params);
  if (role === null) {
    return false;
  }
  if (action === "add") {
    if (role === "viewer" && operatorSessionCap(client, cfg) === "view") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "your operator role permits viewing sessions only"),
      );
      return false;
    }
    if (resolveSessionVisibility(target.entry) !== "suggest") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session is not accepting suggestions"),
      );
      return false;
    }
  } else if (role !== "owner" && role !== "admin") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session owner or operator.admin required"),
    );
    return false;
  }
  const lifecycleError =
    action === "dismiss"
      ? undefined
      : resolveSessionWorkStartError(target.canonicalKey, target.entry);
  if (lifecycleError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, lifecycleError));
    return false;
  }
  return true;
}

export function suggestionScope(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
) {
  return { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath };
}

export function sessionSuggestionSessionChangedError(sessionKey: string): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "session changed before suggestion resolution could be finalized",
    {
      retryable: false,
      details: {
        code: "SESSION_SUGGESTION_SESSION_CHANGED",
        sessionKey,
      },
    },
  );
}

export type SessionSuggestionMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorShape };
type SuggestionWriteScope = ReturnType<typeof suggestionScope> & { env: NodeJS.ProcessEnv };
type SessionSuggestionMutation<T> = {
  mutate: (scope: SuggestionWriteScope, assertCurrent: () => void) => Promise<T>;
} & ({ kind: "start"; action: "add" | SessionSuggestionResolution } | { kind: "settle" });

function resolveCurrentSuggestionTarget(
  target: SessionSharingTarget,
  expectedSessionId: string | undefined,
  current: SessionSharingTarget | null,
) {
  if (
    !current ||
    current.agentId !== target.agentId ||
    current.canonicalKey !== target.canonicalKey ||
    current.storeKey !== target.storeKey ||
    current.storePath !== target.storePath ||
    current.entry.sessionId !== expectedSessionId
  ) {
    throw new SessionWorkStartInvalidatedError("session changed before suggestion mutation");
  }
  return current;
}

export async function createSessionSuggestionMutation(params: {
  target: SessionSharingTarget;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  respond: RespondFn;
  sessionKey: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const scope = { ...suggestionScope(params.target), env: { ...process.env } };
  const expectedSessionId = params.target.entry.sessionId;
  const facts = await prepareSessionMutationFacts({
    cfg: params.context.getRuntimeConfig(),
    sessionKey: params.target.canonicalKey,
    agentId: params.target.agentId,
    allowMissing: true,
  });
  const readCurrent = () => {
    const cfg = params.context.getRuntimeConfig();
    const current = facts.readCurrent(cfg);
    if (!current.sourcePath) {
      throw new SessionMutationFactsUnavailableError();
    }
    const target = resolveCurrentSuggestionTarget(params.target, expectedSessionId, current.target);
    const policyConfig = params.context.getCommittedRuntimeConfig?.() ?? cfg;
    const sharing = prepareProjectedSessionSharing({
      cfg: policyConfig,
      client: params.client,
      isMember: (_target, identityId) => current.membership.has(identityId),
    });
    return { target, physicalStorePath: current.sourcePath, cfg: policyConfig, sharing };
  };
  const run = async <T>(
    operation: SessionSuggestionMutation<T>,
  ): Promise<SessionSuggestionMutationResult<T>> => {
    const rejected = new Error("session suggestion mutation refused");
    let rejectionError: ErrorShape | undefined;
    const assertCurrent = () => {
      if (operation.kind === "start") {
        if (params.signal?.aborted) {
          throw new SessionMutationAuthorizationChangedError(
            errorShape(ErrorCodes.UNAVAILABLE, "suggestion request was cancelled"),
          );
        }
        try {
          params.assertCurrent?.();
        } catch (error) {
          if (error instanceof SessionMutationAuthorizationChangedError) {
            throw error;
          }
          // Host guards also use plain errors. This guard runs before dispatch
          // or a worker commit grant, so its refusal has no accepted write.
          throw new SessionMutationAuthorizationChangedError(
            errorShape(
              ErrorCodes.UNAVAILABLE,
              error instanceof Error ? error.message : "suggestion requester authority changed",
            ),
          );
        }
      }
      const current = readCurrent();
      if (
        operation.kind === "start" &&
        !authorizeSessionSuggestionMutation(
          {
            ...params,
            ...current,
            respond: (_ok, _payload, error) => {
              rejectionError = error;
            },
          },
          operation.action,
        )
      ) {
        throw rejected;
      }
    };
    try {
      // The worker invokes this guard at transaction and commit admission. Accepted
      // input settlement retains its exact token independently of the caller's lifetime.
      assertCurrent();
      const value = await operation.mutate(scope, assertCurrent);
      return { ok: true, value };
    } catch (error) {
      if (error === rejected) {
        return {
          ok: false,
          error: rejectionError ?? errorShape(ErrorCodes.FORBIDDEN, "suggestion mutation refused"),
        };
      }
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return { ok: false, error: error.error };
      }
      if (
        !isSessionWorkStartInvalidatedError(error) &&
        !(error instanceof SessionMutationFactsUnavailableError)
      ) {
        throw error;
      }
      return { ok: false, error: sessionSuggestionSessionChangedError(params.sessionKey) };
    }
  };
  return { run, readCurrent, release: facts.release };
}

export function publishSuggestion(
  context: GatewayRequestContext,
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  requestedSessionKey: string,
  event: SessionSuggestionEvent,
): void {
  context.broadcast("session.suggestion", event, {
    sessionKeys: [
      ...new Set([requestedSessionKey, target.canonicalKey, target.storeKey]),
    ].toSorted(),
    agentId: event.suggestion.agentId,
  });
}
