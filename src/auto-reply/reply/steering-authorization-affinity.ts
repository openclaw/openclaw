import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stableStringify } from "../../agents/stable-stringify.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { isIssuedTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";

export type SteeringAuthorizationAffinity =
  | Readonly<{
      kind: "authority";
      authority: TurnAuthoritySnapshot;
    }>
  | Readonly<{ incomplete: true }>;

const issuedSteeringAuthorizationAffinities = new WeakSet<object>();

function issueSteeringAuthorizationAffinity<T extends object>(value: T): Readonly<T> {
  const issued = Object.freeze(value);
  issuedSteeringAuthorizationAffinities.add(issued);
  return issued;
}

const INCOMPLETE_STEERING_AUTHORIZATION_AFFINITY: SteeringAuthorizationAffinity =
  issueSteeringAuthorizationAffinity({ incomplete: true as const });

/**
 * Captures the host-issued authority that minted an active run's tools.
 * Mutable legacy sender/controller assertions never become a control capability.
 */
export function createSteeringAuthorizationAffinity(params: {
  turnAuthority?: TurnAuthoritySnapshot;
}): SteeringAuthorizationAffinity {
  if (!isIssuedTurnAuthoritySnapshot(params.turnAuthority)) {
    return INCOMPLETE_STEERING_AUTHORIZATION_AFFINITY;
  }
  const authorization = params.turnAuthority.authorization;
  const principal = authorization.principal;
  if (
    principal.kind === "unknown" ||
    !normalizeOptionalString(authorization.agentId) ||
    !normalizeOptionalString(authorization.sessionKey) ||
    !normalizeOptionalString(authorization.conversationId) ||
    ((principal.kind === "operator" || principal.kind === "service") &&
      !params.turnAuthority.controllerKey)
  ) {
    return INCOMPLETE_STEERING_AUTHORIZATION_AFFINITY;
  }
  return issueSteeringAuthorizationAffinity({
    kind: "authority" as const,
    authority: params.turnAuthority,
  });
}

export function steeringAuthorizationAffinitiesMatch(
  expected: SteeringAuthorizationAffinity | undefined,
  incoming: SteeringAuthorizationAffinity | undefined,
): boolean {
  if (!expected || !incoming) {
    return false;
  }
  if (
    !issuedSteeringAuthorizationAffinities.has(expected) ||
    !issuedSteeringAuthorizationAffinities.has(incoming)
  ) {
    return false;
  }
  if ("incomplete" in expected || "incomplete" in incoming) {
    return false;
  }
  return (
    resolveSteeringAuthorizationAffinityKey(expected) ===
    resolveSteeringAuthorizationAffinityKey(incoming)
  );
}

export type SteeringAuthorizationControlPolicy = "exact" | "operator-owner-or-admin";

export type AuthorizedActiveRunAbortOutcome = Readonly<{
  status: "aborted" | "not_active" | "not_abortable" | "unauthorized" | "failed";
  replacementObserved: boolean;
  /** Exact authority of the run that was admitted for control and aborted. */
  controlledAuthorizationAffinity?: SteeringAuthorizationAffinity;
}>;

function resolveIssuedAuthorityAffinity(
  affinity: SteeringAuthorizationAffinity | undefined,
): Extract<SteeringAuthorizationAffinity, { kind: "authority" }> | undefined {
  return affinity &&
    issuedSteeringAuthorizationAffinities.has(affinity) &&
    !("incomplete" in affinity) &&
    affinity.kind === "authority"
    ? affinity
    : undefined;
}

function authorityTargetsMatch(
  expected: Extract<SteeringAuthorizationAffinity, { kind: "authority" }>,
  incoming: Extract<SteeringAuthorizationAffinity, { kind: "authority" }>,
): boolean {
  const expectedAuthorization = expected.authority.authorization;
  const incomingAuthorization = incoming.authority.authorization;
  return Boolean(
    expectedAuthorization.agentId &&
    expectedAuthorization.sessionKey &&
    expectedAuthorization.agentId === incomingAuthorization.agentId &&
    expectedAuthorization.sessionKey === incomingAuthorization.sessionKey,
  );
}

/**
 * Authorizes active-run control without exposing a forgeable ownership token.
 * Implicit interruption is exact-only; explicit operator control may additionally
 * use the authenticated owning controller or an admin-scoped controller.
 */
export function steeringAuthorizationAffinityAllowsControl(params: {
  expected: SteeringAuthorizationAffinity | undefined;
  incoming: SteeringAuthorizationAffinity | undefined;
  policy: SteeringAuthorizationControlPolicy;
}): boolean {
  if (steeringAuthorizationAffinitiesMatch(params.expected, params.incoming)) {
    return true;
  }
  if (params.policy === "exact") {
    return false;
  }

  const incoming = resolveIssuedAuthorityAffinity(params.incoming);
  if (!incoming) {
    return false;
  }
  const principal = incoming.authority.authorization.principal;
  const isAdmin = principal.kind === "operator" && principal.scopes.includes("operator.admin");
  const expected = resolveIssuedAuthorityAffinity(params.expected);
  if (isAdmin) {
    return expected ? authorityTargetsMatch(expected, incoming) : true;
  }
  return Boolean(
    expected &&
    authorityTargetsMatch(expected, incoming) &&
    expected.authority.controllerKey &&
    expected.authority.controllerKey === incoming.authority.controllerKey,
  );
}

/** Stable equivalence key for queue collection and live steering admission. */
export function resolveSteeringAuthorizationAffinityKey(
  affinity: SteeringAuthorizationAffinity | undefined,
): string | undefined {
  if (
    !affinity ||
    !issuedSteeringAuthorizationAffinities.has(affinity) ||
    "incomplete" in affinity
  ) {
    return undefined;
  }
  const authority = affinity.authority;
  return stableStringify({
    kind: affinity.kind,
    principal: authority.authorization.principal,
    agentId: authority.authorization.agentId,
    sessionKey: authority.authorization.sessionKey,
    conversationId: authority.authorization.conversationId,
    parentConversationId: authority.authorization.parentConversationId,
    threadId: authority.authorization.threadId,
    controllerKey: authority.controllerKey,
    capabilityDigest: authority.capabilityDigest,
  });
}
