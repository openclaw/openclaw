import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import {
  authorizeOwnSessionMutation,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import type { SessionMutationTarget } from "./session-sharing-target-input.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Omit<SessionSharingTarget, "entry" | "storeKeys"> | null;
  sessionId: string | null;
  lifecycleRevision?: string;
  created?: true;
  absentTarget?: GatewaySessionStoreTarget;
};

export type ExpectedSessionMutationTarget = Readonly<{
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
}>;

export type PreparedMutationSharing = {
  target: SessionSharingTarget | null;
  members: readonly import("../config/sessions/session-sharing-store.kernel.js").SessionMember[];
  assertCurrent: () => void;
};

export type SessionSharingLookupCaches = {
  storeCache: GatewaySessionStoreCache;
  targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
};

export function createSessionSharingLookupCaches(): SessionSharingLookupCaches {
  return { storeCache: new Map(), targetDiscoveryCache: new Map() };
}

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
  facts: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    entry: SessionEntry | undefined;
    readSource?: import("../config/sessions/session-accessor.types.js").CapturedSessionEntryReadSource;
  };
  targetChanged: () => Error;
}): SessionSharingTarget | null {
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
  const expectedReadSource = original?.readSource;
  if (
    !expectedRoute ||
    facts.agentId !== expectedRoute.agentId ||
    facts.sessionKey !== expectedRoute.sessionKey ||
    (expectedReadSource
      ? facts.readSource?.databaseIdentity !== expectedReadSource.databaseIdentity ||
        facts.readSource.databaseBirthtime !== expectedReadSource.databaseBirthtime ||
        facts.readSource.agentId !== expectedReadSource.agentId
      : facts.storePath !== expectedRoute.storePath)
  ) {
    throw params.targetChanged();
  }
  return facts.entry
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
    : null;
}
