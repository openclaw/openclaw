// ─────────────────────────────────────────────
//  OpenClaw Shield — Emergency Escalation
//  Multi-function failure detection and
//  graduated emergency response.
//  Adapted from Kairos Shield Protocol (Layer 4)
//  By Kairos Lab
// ─────────────────────────────────────────────

// ─── Types ───────────────────────────────────

export type EscalationAction = "NONE" | "ALERT" | "PARTIAL_PAUSE" | "FULL_PAUSE";

export interface EscalationRule {
  id: string;
  condition: string;
  action: EscalationAction;
}

export interface EscalationResult {
  action: EscalationAction;
  ruleId: string;
  details: {
    openCircuits: string[];
    criticalDown: string[];
    totalOpen: number;
    totalCriticalDown: number;
  };
}

export interface PartialPauseConfig {
  newConnections: boolean;
  existingAuth: boolean;
  pluginLoading: boolean;
}

export interface EmergencyPayload {
  ruleId: string;
  action: EscalationAction;
  openCircuits: string[];
  criticalDown: string[];
  timestamp: string;
}

// ─── Constants ───────────────────────────────

/**
 * Gateway-critical functions — if any of these are down, the gateway is degraded.
 * Adapted for OpenClaw's gateway architecture.
 */
export const GATEWAY_CRITICAL_FUNCTIONS = [
  "ws-connection",
  "auth-handler",
  "message-handler",
  "plugin-http",
] as const;

export const ESCALATION_RULES: EscalationRule[] = [
  {
    id: "SINGLE_CRITICAL",
    condition: "1 gateway-critical function in CIRCUIT_OPEN",
    action: "ALERT",
  },
  {
    id: "MULTI_CRITICAL",
    condition: "3+ functions in CIRCUIT_OPEN simultaneously",
    action: "PARTIAL_PAUSE",
  },
  {
    id: "GATEWAY_PIPELINE_DOWN",
    condition: "ws-connection OR auth-handler in CIRCUIT_OPEN",
    action: "PARTIAL_PAUSE",
  },
  {
    id: "TOTAL_FAILURE",
    condition: "10+ functions in CIRCUIT_OPEN OR all gateway functions down",
    action: "FULL_PAUSE",
  },
];

export const TOTAL_FAILURE_THRESHOLD = 10;
export const MULTI_CRITICAL_THRESHOLD = 3;

// ─── Escalation Evaluation ──────────────────

export function evaluateEscalation(openCircuits: string[]): EscalationResult {
  const criticalDown = openCircuits.filter((fn) => isGatewayCritical(fn));

  const details = {
    openCircuits,
    criticalDown,
    totalOpen: openCircuits.length,
    totalCriticalDown: criticalDown.length,
  };

  // TOTAL_FAILURE
  if (
    openCircuits.length >= TOTAL_FAILURE_THRESHOLD ||
    criticalDown.length >= GATEWAY_CRITICAL_FUNCTIONS.length
  ) {
    return { action: "FULL_PAUSE", ruleId: "TOTAL_FAILURE", details };
  }

  // GATEWAY_PIPELINE_DOWN
  if (criticalDown.includes("ws-connection") || criticalDown.includes("auth-handler")) {
    return { action: "PARTIAL_PAUSE", ruleId: "GATEWAY_PIPELINE_DOWN", details };
  }

  // MULTI_CRITICAL
  if (openCircuits.length >= MULTI_CRITICAL_THRESHOLD) {
    return { action: "PARTIAL_PAUSE", ruleId: "MULTI_CRITICAL", details };
  }

  // SINGLE_CRITICAL
  if (criticalDown.length >= 1) {
    return { action: "ALERT", ruleId: "SINGLE_CRITICAL", details };
  }

  return { action: "NONE", ruleId: "", details };
}

// ─── Helpers ────────────────────────────────

export function isGatewayCritical(functionName: string): boolean {
  return (GATEWAY_CRITICAL_FUNCTIONS as readonly string[]).includes(functionName);
}

export function getPartialPauseConfig(): PartialPauseConfig {
  return {
    newConnections: false,
    existingAuth: true,
    pluginLoading: false,
  };
}

export function buildEmergencyPayload(
  ruleId: string,
  openCircuits: string[],
  criticalDown: string[],
): EmergencyPayload {
  const ruleActionMap: Record<string, EscalationAction> = {
    TOTAL_FAILURE: "FULL_PAUSE",
    GATEWAY_PIPELINE_DOWN: "PARTIAL_PAUSE",
    MULTI_CRITICAL: "PARTIAL_PAUSE",
    SINGLE_CRITICAL: "ALERT",
  };
  const action: EscalationAction = ruleActionMap[ruleId] ?? "NONE";

  return {
    ruleId,
    action,
    openCircuits,
    criticalDown,
    timestamp: new Date().toISOString(),
  };
}
