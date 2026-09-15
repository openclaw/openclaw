import {
  ErrorCodes,
  errorShape,
  type SessionSuggestionEvent,
  type SessionSuggestionResolution,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveSessionWorkStartError,
  SessionWorkStartInvalidatedError,
  isSessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withOpenClawAgentDatabaseAsync } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { hasOperatorBoundary, operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

function canSeeSuggestionTarget(params: {
  client: GatewayClient | null;
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
}): boolean {
  return (
    !hasOperatorBoundary(params.client, params.cfg) ||
    createSessionListEntryFilter({ client: params.client, cfg: params.cfg })?.(
      params.target.storeKey,
      params.target.entry,
    ) !== false
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
  if (!target || !canSeeSuggestionTarget({ client: params.client, cfg, target })) {
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
}) {
  const role = resolveSessionSharingRole({
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
  const error = authorizeSessionSharingTarget({
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

export function respondSessionSuggestionSessionChanged(
  respond: RespondFn,
  sessionKey: string,
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.UNAVAILABLE,
      "session changed before suggestion resolution could be finalized",
      {
        retryable: false,
        details: {
          code: "SESSION_SUGGESTION_SESSION_CHANGED",
          sessionKey,
        },
      },
    ),
  );
}

export type SessionSuggestionMutationResult<T> = { ok: true; value: T } | { ok: false };
type SuggestionWriteScope = ReturnType<typeof suggestionScope> & { env: NodeJS.ProcessEnv };
type SessionSuggestionMutation<T> = {
  mutate: (scope: SuggestionWriteScope) => T;
} & ({ kind: "start"; action: "add" | SessionSuggestionResolution } | { kind: "settle" });

export function resolveCurrentSuggestionTarget(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  expectedSessionId: string | undefined,
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>,
) {
  const current = resolveSessionSharingTarget({
    cfg,
    sessionKey: target.canonicalKey,
    agentId: target.agentId,
  });
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

export function createSessionSuggestionMutation(params: {
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  respond: RespondFn;
  sessionKey: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const scope = { ...suggestionScope(params.target), env: { ...process.env } };
  const databaseOptions = toDatabaseOptions(resolveSqliteScope(scope));
  const expectedSessionId = params.target.entry.sessionId;
  return async <T>(
    operation: SessionSuggestionMutation<T>,
  ): Promise<SessionSuggestionMutationResult<T>> => {
    const rejected = new Error("session suggestion mutation refused");
    const assertCurrent = () => {
      if (operation.kind === "start") {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
      }
      const cfg = params.context.getRuntimeConfig();
      const current = resolveCurrentSuggestionTarget(params.target, expectedSessionId, cfg);
      if (
        operation.kind === "start" &&
        !authorizeSessionSuggestionMutation(
          {
            client: params.client,
            cfg,
            sessionKey: params.sessionKey,
            target: current,
            respond: params.respond,
          },
          operation.action,
        )
      ) {
        throw rejected;
      }
    };
    try {
      return await runOpenClawAgentWriteAdmission(
        databaseOptions,
        () =>
          withOpenClawAgentDatabaseAsync(
            databaseOptions,
            // Settlement retains the accepted dispatch token; a later caller abort cannot replay it.
            (database) => ({
              ok: true as const,
              value: operation.mutate({ ...scope, storePath: database.path }),
            }),
            assertCurrent,
          ),
        true,
      );
    } catch (error) {
      if (error === rejected) {
        return { ok: false };
      }
      if (error instanceof SessionMutationAuthorizationChangedError) {
        params.respond(false, undefined, error.error);
        return { ok: false };
      }
      if (!isSessionWorkStartInvalidatedError(error)) {
        throw error;
      }
      respondSessionSuggestionSessionChanged(params.respond, params.sessionKey);
      return { ok: false };
    }
  };
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
