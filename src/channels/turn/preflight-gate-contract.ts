/**
 * `before_route_inbound_message` preflight-v1 gate contract types.
 *
 * Leaf contract shared by the runtime seam (`before-route-inbound-message.ts`),
 * the channel-turn types barrel (`types.ts`), and tests. Kept free of imports
 * from the turn module so the type graph stays acyclic.
 *
 * Contract: docs/contracts/preflight-v1.md. Exit-code mapping:
 *   exit 0 -> ALLOW  -> proceed to routing
 *   exit 1 -> REJECT -> block the invocation (fail-closed)
 *   exit 2 -> CONFIG/USAGE error -> block + operator alert (fail-closed)
 *   any other non-zero exit -> block
 */

/** Facts passed to the gate for one inbound message. */
export type PreflightGateInvocation = {
  actor?: string;
  agent?: string;
  capability?: string;
  route?: string;
  tenant?: {
    counterpartyId?: string;
    clientId?: string;
    projectId?: string;
    jwt?: string;
    audience?: string;
  };
  consentFile?: string;
  postureFile?: string;
  principals?: string;
  eventLog?: string;
};

/** The `preflight.decision.v1` envelope emitted by the gate (contract §Event). */
export type PreflightDecisionEvent = {
  event: "preflight.decision.v1";
  timestamp: string;
  agentId?: string;
  actor?: string;
  capability?: string;
  decision: "allow" | "reject";
  reason: string;
  principalKnown: boolean;
  tenant?: string;
  consent?: string;
  posture?: string;
  /** Forward-compatible additive field kept per §7.2 envelopes. */
  category?: string;
};

export type PreflightGateDecision = "allow" | "reject" | "config-error";

export type PreflightGateOutcome = {
  exitCode: number;
  decision: PreflightGateDecision;
  event: PreflightDecisionEvent | null;
  stderr?: string;
};

/** Spawn contract injected for tests; the real default runs `python3 <gate>`. */
export type PreflightGateSpawn = (
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface PreflightGateClient {
  readonly configured: boolean;
  invoke(invocation: PreflightGateInvocation): Promise<PreflightGateOutcome>;
}

/** Context extractable at the inbound-routing seam for one message. */
export type BeforeRouteInboundMessageTurnOptions = {
  gate: PreflightGateClient;
  actor?: string;
  agent?: string;
  capability?: string;
  route?: string;
  eventLog?: string;
};
