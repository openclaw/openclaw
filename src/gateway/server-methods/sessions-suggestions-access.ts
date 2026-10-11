import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSuggestionResolution,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveSessionWorkStartError,
  SessionWorkStartInvalidatedError,
  isSessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { hasOperatorBoundary, operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import type { captureSessionSharingMemoryFacts } from "../session-sharing-incognito.js";
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

export function requireSuggestionTarget(params: {
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
  if (!target) {
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
  target: ReturnType<typeof resolveSessionSharingTarget>;
  respond: RespondFn;
  sharing?: ReturnType<typeof prepareProjectedSessionSharing>;
}) {
  const { target, client, cfg, sharing } = params;
  const entryFilter = hasOperatorBoundary(client, cfg)
    ? (sharing?.entryFilter ?? createSessionListEntryFilter({ client, cfg }))
    : undefined;
  if (!target || entryFilter?.(target.storeKey, target.entry) === false) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  const role = sharing?.roleForTarget(target) ?? resolveSessionSharingRole({ client, cfg, target });
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target,
  });
  if (incognitoError) {
    params.respond(false, undefined, incognitoError);
    return null;
  }
  if (resolveSessionVisibility(target.entry) !== "draft") {
    return role;
  }
  const error = sharing
    ? sharing.authorizeTarget(target)
    : authorizeSessionSharingTarget({ client, cfg, target });
  if (!error) {
    return role;
  }
  params.respond(false, undefined, error);
  return null;
}

export function authorizeSessionSuggestionMutation(
  params: Parameters<typeof requireVisibleSuggestionRole>[0] & { target: SessionSharingTarget },
  action: "add" | SessionSuggestionResolution,
): boolean {
  const { cfg, client, target, respond } = params;
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

export function suggestionScope(target: SessionSharingTarget) {
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

export async function createSessionSuggestionMutation(params: {
  target: SessionSharingTarget;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  respond: RespondFn;
  sessionKey: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const scope = captureSessionTranscriptTargetBinding(suggestionScope(params.target));
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
    const target = current.target;
    if (
      !target ||
      target.agentId !== params.target.agentId ||
      target.canonicalKey !== params.target.canonicalKey ||
      target.storeKey !== params.target.storeKey ||
      target.storePath !== params.target.storePath ||
      target.entry.sessionId !== expectedSessionId
    ) {
      throw new SessionWorkStartInvalidatedError("session changed before suggestion mutation");
    }
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

export function readCollaborationTarget(
  projection: Pick<SessionRowProjection, "describe" | "sharingTargetState">,
  query: { key: string; agentId: string },
  actorFacts?: ReturnType<typeof captureSessionSharingMemoryFacts>,
) {
  if (actorFacts) {
    const target = actorFacts.readCurrent().target;
    return target && { ...target, generation: target.readSource.databaseIdentity };
  }
  const current = projection.sharingTargetState(query);
  return current.status === "ready" ? current.target : null;
}
