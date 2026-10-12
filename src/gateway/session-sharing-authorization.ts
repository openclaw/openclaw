import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";
import type { SessionOperatorScope } from "../shared/session-method-scopes-base.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import { isSyntheticGatewayCaller } from "./server-methods/gateway-personal-caller.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { isSessionArchiveMutation } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  authorizeOwnSessionMutation,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import type {
  PreparedMutationSharing,
  PreparedSessionSharingProfiles,
} from "./session-sharing-read.js";
import {
  resolveChatSendAuthorizationParams,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import type { GatewaySessionStoreCache } from "./session-utils-store-lookup.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export type SessionMutationAuthorizationParams = {
  client: GatewayClient | null;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  /** Trusted prepared identity; never adopt a later target while capturing authority. */
  expectedTarget?: ExpectedSessionMutationTarget;
  /** The router's actual alternative admission, not other grants on the same client. */
  sessionScope?: SessionOperatorScope;
  sessionRowRead?: SessionRowReadView;
  preparedSharing?: PreparedMutationSharing;
  preparedProfiles?: PreparedSessionSharingProfiles;
};

export function prepareSessionMutationAuthorizationRequest(
  request: SessionMutationAuthorizationParams,
) {
  let params = { ...request };
  params.preparedProfiles?.readCurrent();
  if (params.method === "chat.send") {
    const normalized = resolveChatSendAuthorizationParams(
      params.context.getRuntimeConfig(),
      params.requestParams,
    );
    if (!normalized.ok) {
      return { ok: false as const, error: normalized.error };
    }
    params = { ...params, requestParams: normalized.value };
  }
  const patch =
    params.method === "sessions.patchMany" && isRecord(params.requestParams)
      ? params.requestParams.patch
      : params.requestParams;
  const requiresCommunicationAuthority =
    ["sessions.create", "sessions.patch", "sessions.patchMany"].includes(params.method) &&
    isRecord(patch) &&
    Object.hasOwn(patch, "communication");
  if (
    requiresCommunicationAuthority &&
    (!params.client || isSyntheticGatewayCaller(params.client))
  ) {
    return {
      ok: false as const,
      error: errorShape(
        ErrorCodes.FORBIDDEN,
        "Session communication settings require a direct human request.",
      ),
    };
  }
  return {
    ok: true as const,
    params,
    requiresCommunicationAuthority,
    targetOwnership: {
      requireOwner:
        requiresCommunicationAuthority ||
        isSessionArchiveMutation(params.method, params.requestParams),
      ownerAction: requiresCommunicationAuthority ? "change communication settings" : undefined,
    },
  };
}

export type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Omit<SessionSharingTarget, "entry" | "storeKeys"> | null;
  sessionId: string | null;
  lifecycleRevision?: string;
  created?: true;
  absentTarget?: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath"> &
    Pick<SessionSharingTarget, "readSource">;
  projection?: import("./session-row-projection.js").SessionRowProjection;
};

export type ExpectedSessionMutationTarget = Readonly<{
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
}>;

export type { PreparedMutationSharing } from "./session-sharing-read.js";

export type SessionSharingLookupCaches = {
  storeCache: GatewaySessionStoreCache;
  targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
};

export function createSessionSharingLookupCaches(): SessionSharingLookupCaches {
  return { storeCache: new Map(), targetDiscoveryCache: new Map() };
}

// docs/gateway/protocol.md gives these handlers visibility-based authorization.
// The router still prevents view/suggest-capped callers from reassigning foreign sessions.
export const VISIBILITY_AUTHORIZED_METHODS = new Set(["sessions.assignOwner"]);

export function resolveOwnSessionProfileAuthorization(params: {
  client: GatewayClient | null;
  bindsOwnProfile: boolean;
}): { profileId?: string; error: ErrorShape | null } {
  if (!params.bindsOwnProfile) {
    return { error: null };
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const profileId = actor?.kind === "operator" ? actor.profileId : undefined;
  if (!profileId) {
    return { error: authenticatedProfileUnavailableError() };
  }
  return {
    profileId,
    error: authorizeOwnSessionMutation({
      client: params.client,
      target: null,
      expectedProfileId: profileId,
    }),
  };
}

export function sessionMutationTargetChanged(method: string, sessionKey: string) {
  return new SessionMutationAuthorizationChangedError(
    errorShape(ErrorCodes.INVALID_REQUEST, `session changed before ${method}; retry the request`, {
      details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED", method, sessionKey },
    }),
  );
}

export function expectedSessionMutationTargetError(
  expected: ExpectedSessionMutationTarget | undefined,
  target: SessionSharingTarget | null,
  method: string,
): ErrorShape | null {
  return expected &&
    (!target ||
      target.agentId !== expected.agentId ||
      target.canonicalKey !== expected.sessionKey ||
      target.storePath !== expected.storePath ||
      target.entry.sessionId?.trim() !== expected.sessionId)
    ? sessionMutationTargetChanged(method, expected.sessionKey).error
    : null;
}

export function prepareAuthorizedSessionMutationFacts(params: {
  expected: AuthorizedSessionMutationTarget;
  source?: import("../config/sessions/session-entry-read-source.types.js").CapturedSessionEntryReadSource;
  facts: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    entry: SessionEntry | undefined;
    readSource?: import("../config/sessions/session-entry-read-source.types.js").CapturedSessionEntryReadSource;
  };
  targetChanged: () => Error;
}): Pick<PreparedMutationSharing, "target" | "storageTarget"> {
  const { expected, facts } = params;
  const original = expected.resolved;
  const expectedRoute = original
    ? {
        agentId: original.agentId,
        storePath: original.storePath,
        sessionKey: original.canonicalKey,
        storeKey: original.storeKey,
      }
    : expected.absentTarget
      ? {
          agentId: expected.absentTarget.agentId,
          storePath: expected.absentTarget.storePath,
          sessionKey: expected.absentTarget.canonicalKey,
          storeKey: expected.absentTarget.canonicalKey,
        }
      : undefined;
  const expectedReadSource = original?.readSource ?? params.source;
  if (
    !expectedRoute ||
    facts.agentId !== expectedRoute.agentId ||
    facts.sessionKey !==
      toAgentStoreSessionKey({
        agentId: expectedRoute.agentId,
        requestKey: expectedRoute.storeKey,
      }) ||
    (expectedReadSource
      ? facts.readSource?.databaseIdentity !== expectedReadSource.databaseIdentity ||
        facts.readSource.databaseBirthtime !== expectedReadSource.databaseBirthtime ||
        facts.readSource.agentId !== expectedReadSource.agentId
      : facts.storePath !== expectedRoute.storePath)
  ) {
    throw params.targetChanged();
  }
  // Qualified worker reads use agent store keys. Preserve the validated logical
  // route so a global request does not acquire a different session identity.
  return {
    storageTarget: {
      agentId: expectedRoute.agentId,
      canonicalKey: expectedRoute.sessionKey,
      storePath: expectedRoute.storePath,
    },
    target: facts.entry
      ? {
          ...(original ?? {
            agentId: expectedRoute.agentId,
            canonicalKey: expectedRoute.sessionKey,
            storeKey: expectedRoute.sessionKey,
            storePath: expectedRoute.storePath,
          }),
          storeKeys: [expectedRoute.storeKey],
          entry: facts.entry,
        }
      : null,
  };
}

export function assertSessionMutationProjectionCurrent(
  expected: AuthorizedSessionMutationTarget | undefined,
  context: GatewayRequestContext,
  changed: () => Error,
): void {
  if (expected?.projection && getSessionRowProjection(context) !== expected.projection) {
    throw changed();
  }
}

/** Only an acknowledged creation may advance an absent or idless Talk admission. */
export function createSessionCreationAuthorizationRecorder(params: {
  targets: AuthorizedSessionMutationTarget[];
  talkSessionTarget: SessionMutationAuthorization["talkSessionTarget"];
  permitsGeneratedSession: boolean;
}): NonNullable<SessionMutationAuthorization["recordCreatedSession"]> {
  let createdSessionRecorded = false;
  return (created) => {
    // Only the creation owner's COMMIT notification may replace an absent snapshot.
    // Never adopt a response/reload result, or a later incarnation of the same key.
    if (createdSessionRecorded) {
      return;
    }
    let expected = params.targets.find((target) => {
      const route = target.absentTarget ?? (params.talkSessionTarget ? target.resolved : null);
      return (
        target.sessionId === null &&
        route?.agentId === created.agentId &&
        route.canonicalKey === created.sessionKey &&
        route.storePath === created.storePath
      );
    });
    if (!expected && params.permitsGeneratedSession) {
      expected = {
        sessionKey: created.sessionKey,
        agentId: created.agentId,
        resolved: null,
        sessionId: null,
      };
      params.targets.push(expected);
    }
    if (!expected) {
      return;
    }
    createdSessionRecorded = true;
    expected.resolved = {
      ...expected.resolved,
      agentId: created.agentId,
      canonicalKey: created.sessionKey,
      storeKey: created.sessionKey,
      storePath: created.storePath,
      ...(created.readSource ? { readSource: created.readSource } : {}),
    };
    expected.sessionId = created.sessionId;
    expected.lifecycleRevision = created.lifecycleRevision;
    expected.created = true;
  };
}
