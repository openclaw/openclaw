export type SessionStewardBoundaryKind = "agent" | "global" | "unscoped" | "unknown" | "malformed";

export type SessionStewardAgentRelation = "same_agent" | "cross_agent" | "unbound";

export type SessionStewardBoundaryDecision = {
  kind: SessionStewardBoundaryKind;
  ownerAgentId: string;
  requestedAgentId: string;
  agentRelation: SessionStewardAgentRelation;
  affectedSession: string;
};

export type ResolveSessionStewardBoundaryParams = {
  sessionKey?: string | null;
  requestedAgentId?: string | null;
};

const UNKNOWN = "UNKNOWN";

function normalizeBoundarySegment(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function unknownDecision(requestedAgentId: string): SessionStewardBoundaryDecision {
  return {
    kind: "unknown",
    ownerAgentId: UNKNOWN,
    requestedAgentId,
    agentRelation: "unbound",
    affectedSession: UNKNOWN,
  };
}

function malformedDecision(requestedAgentId: string): SessionStewardBoundaryDecision {
  return {
    kind: "malformed",
    ownerAgentId: UNKNOWN,
    requestedAgentId,
    agentRelation: "unbound",
    affectedSession: UNKNOWN,
  };
}

function resolveAgentRelation(
  ownerAgentId: string,
  requestedAgentId: string,
): SessionStewardAgentRelation {
  if (!ownerAgentId || !requestedAgentId || requestedAgentId === UNKNOWN) {
    return "unbound";
  }
  return ownerAgentId === requestedAgentId ? "same_agent" : "cross_agent";
}

// Session Steward policy returns only normalized owners and redacted selectors.
// Raw session tails remain outside this decision object to keep boundary logs safe.
export function resolveSessionStewardBoundary(
  params: ResolveSessionStewardBoundaryParams,
): SessionStewardBoundaryDecision {
  const requestedAgentId = normalizeBoundarySegment(params.requestedAgentId) || UNKNOWN;
  const normalizedSessionKey = normalizeBoundarySegment(params.sessionKey);
  if (!normalizedSessionKey) {
    return unknownDecision(requestedAgentId);
  }
  if (normalizedSessionKey === "global") {
    return {
      kind: "global",
      ownerAgentId: UNKNOWN,
      requestedAgentId,
      agentRelation: "unbound",
      affectedSession: "GLOBAL",
    };
  }

  const parts = normalizedSessionKey.split(":");
  if (parts[0] !== "agent") {
    return {
      kind: "unscoped",
      ownerAgentId: UNKNOWN,
      requestedAgentId,
      agentRelation: "unbound",
      affectedSession: "UNSCOPED",
    };
  }

  const ownerAgentId = parts[1]?.trim() ?? "";
  const hasMalformedEmptyTail =
    parts.length > 2 && !parts.slice(2).some((part) => part.trim().length > 0);
  if (!ownerAgentId || hasMalformedEmptyTail) {
    return malformedDecision(requestedAgentId);
  }

  return {
    kind: "agent",
    ownerAgentId,
    requestedAgentId,
    agentRelation: resolveAgentRelation(ownerAgentId, requestedAgentId),
    affectedSession: `agent:${ownerAgentId}:REDACTED`,
  };
}
