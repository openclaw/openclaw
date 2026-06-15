// Gateway wrappers keep Session Steward policy errors redacted and protocol-shaped.
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  resolveSessionStewardBoundary,
  type SessionStewardAgentRelation,
  type SessionStewardBoundaryDecision,
} from "../sessions/session-steward-policy.js";

export type GatewaySessionStewardBoundaryFacts = {
  affectedSession: string;
  ownerAgentId: string;
  requestedAgentId: string;
  agentRelation: SessionStewardAgentRelation;
};

export type GatewaySessionStewardBoundaryCheck =
  | {
      ok: true;
      boundary: GatewaySessionStewardBoundaryFacts;
      decision: SessionStewardBoundaryDecision;
    }
  | {
      ok: false;
      boundary: GatewaySessionStewardBoundaryFacts;
      decision: SessionStewardBoundaryDecision;
      error: ReturnType<typeof errorShape>;
    };

function toGatewaySessionStewardBoundaryFacts(
  decision: SessionStewardBoundaryDecision,
): GatewaySessionStewardBoundaryFacts {
  return {
    affectedSession: decision.affectedSession,
    ownerAgentId: decision.ownerAgentId,
    requestedAgentId: decision.requestedAgentId,
    agentRelation: decision.agentRelation,
  };
}

function sessionBoundaryErrorMessage(decision: SessionStewardBoundaryDecision): string {
  return decision.kind === "malformed"
    ? "malformed session boundary"
    : "session key agent does not match agentId";
}

export function resolveGatewaySessionStewardBoundary(params: {
  sessionKey?: string | null;
  requestedAgentId?: string | null;
}): {
  boundary: GatewaySessionStewardBoundaryFacts;
  decision: SessionStewardBoundaryDecision;
} {
  const decision = resolveSessionStewardBoundary(params);
  return {
    decision,
    boundary: toGatewaySessionStewardBoundaryFacts(decision),
  };
}

export function assertGatewaySessionStewardBoundary(params: {
  sessionKey?: string | null;
  requestedAgentId?: string | null;
}): GatewaySessionStewardBoundaryCheck {
  const resolved = resolveGatewaySessionStewardBoundary(params);
  const invalid =
    resolved.decision.kind === "malformed" || resolved.decision.agentRelation === "cross_agent";
  if (!invalid) {
    return { ok: true, ...resolved };
  }
  return {
    ok: false,
    ...resolved,
    error: errorShape(ErrorCodes.INVALID_REQUEST, sessionBoundaryErrorMessage(resolved.decision), {
      details: { sessionBoundary: resolved.boundary },
    }),
  };
}
