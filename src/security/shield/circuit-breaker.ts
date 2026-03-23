// ─────────────────────────────────────────────
//  OpenClaw Shield — Circuit Breaker
//  3-state circuit breaker (CLOSED/HALF_OPEN/OPEN)
//  with exponential backoff for gateway protection.
//  Adapted from Kairos Shield Protocol (Layer 4)
//  By Kairos Lab
// ─────────────────────────────────────────────

// ─── Types ───────────────────────────────────

export interface CircuitState {
  functionName: string;
  state: "CLOSED" | "HALF_OPEN" | "OPEN";
  failureCount: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  halfOpenAt: number | null;
  cooldownSeconds: number;
  testRequestsAllowed: number;
  testRequestsProcessed: number;
  testSuccessCount: number;
}

export interface CircuitCheckResult {
  allowed: boolean;
  state: "CLOSED" | "HALF_OPEN" | "OPEN";
  retryAfter?: number;
}

export interface CircuitRecordResult {
  circuit: CircuitState;
  stateChanged: boolean;
  newState?: "CLOSED" | "HALF_OPEN" | "OPEN";
}

// ─── Constants ───────────────────────────────

export const CIRCUIT_CONFIG = {
  /** Consecutive failures to trip the circuit open */
  FAILURE_THRESHOLD: 10,
  /** How long (seconds) circuit stays OPEN before transitioning to HALF_OPEN */
  COOLDOWN_SECONDS: 60,
  /** How many test requests to allow in HALF_OPEN */
  HALF_OPEN_TEST_REQUESTS: 5,
  /** How many test requests must succeed to close the circuit */
  HALF_OPEN_SUCCESS_THRESHOLD: 4,
  /** Maximum cooldown duration (seconds) for exponential backoff */
  MAX_COOLDOWN_SECONDS: 300,
} as const;

// ─── State Checks ───────────────────────────

export function shouldOpenCircuit(failureCount: number): boolean {
  return failureCount >= CIRCUIT_CONFIG.FAILURE_THRESHOLD;
}

export function shouldTransitionToHalfOpen(circuit: CircuitState, now: number): boolean {
  if (circuit.state !== "OPEN" || circuit.openedAt === null) {
    return false;
  }
  const elapsed = now - circuit.openedAt;
  return elapsed >= circuit.cooldownSeconds * 1000;
}

export function evaluateHalfOpen(circuit: CircuitState): "CLOSE" | "REOPEN" | "TESTING" {
  if (circuit.state !== "HALF_OPEN") {
    return "TESTING";
  }

  if (circuit.testRequestsProcessed >= circuit.testRequestsAllowed) {
    if (circuit.testSuccessCount >= CIRCUIT_CONFIG.HALF_OPEN_SUCCESS_THRESHOLD) {
      return "CLOSE";
    }
    return "REOPEN";
  }

  return "TESTING";
}

export function getNextCooldown(currentCooldown: number): number {
  return Math.min(currentCooldown * 2, CIRCUIT_CONFIG.MAX_COOLDOWN_SECONDS);
}

// ─── Circuit Check ──────────────────────────

export function checkCircuit(circuit: CircuitState, now: number): CircuitCheckResult {
  switch (circuit.state) {
    case "CLOSED":
      return { allowed: true, state: "CLOSED" };

    case "OPEN": {
      if (shouldTransitionToHalfOpen(circuit, now)) {
        return { allowed: true, state: "HALF_OPEN" };
      }
      const elapsed = now - (circuit.openedAt ?? now);
      const remaining = Math.ceil((circuit.cooldownSeconds * 1000 - elapsed) / 1000);
      return {
        allowed: false,
        state: "OPEN",
        retryAfter: Math.max(1, remaining),
      };
    }

    case "HALF_OPEN": {
      const evaluation = evaluateHalfOpen(circuit);
      if (evaluation === "CLOSE") {
        return { allowed: true, state: "CLOSED" };
      }
      if (evaluation === "REOPEN") {
        const newCooldown = getNextCooldown(circuit.cooldownSeconds);
        return { allowed: false, state: "OPEN", retryAfter: newCooldown };
      }
      return { allowed: true, state: "HALF_OPEN" };
    }
  }
}

// ─── Record Results ─────────────────────────

export function recordSuccess(circuit: CircuitState): CircuitRecordResult {
  const updated = { ...circuit };

  if (circuit.state === "HALF_OPEN") {
    updated.testRequestsProcessed = circuit.testRequestsProcessed + 1;
    updated.testSuccessCount = circuit.testSuccessCount + 1;

    if (updated.testRequestsProcessed >= updated.testRequestsAllowed) {
      if (updated.testSuccessCount >= CIRCUIT_CONFIG.HALF_OPEN_SUCCESS_THRESHOLD) {
        return { circuit: resetCircuit(updated), stateChanged: true, newState: "CLOSED" };
      }
      return { circuit: reopenCircuit(updated), stateChanged: true, newState: "OPEN" };
    }

    return { circuit: updated, stateChanged: false };
  }

  updated.failureCount = 0;
  return { circuit: updated, stateChanged: false };
}

export function recordFailure(circuit: CircuitState, now: number): CircuitRecordResult {
  const updated = { ...circuit };
  updated.lastFailureAt = now;

  if (circuit.state === "HALF_OPEN") {
    updated.testRequestsProcessed = circuit.testRequestsProcessed + 1;

    if (updated.testRequestsProcessed >= updated.testRequestsAllowed) {
      if (updated.testSuccessCount >= CIRCUIT_CONFIG.HALF_OPEN_SUCCESS_THRESHOLD) {
        return { circuit: resetCircuit(updated), stateChanged: true, newState: "CLOSED" };
      }
      return { circuit: reopenCircuit(updated), stateChanged: true, newState: "OPEN" };
    }

    return { circuit: updated, stateChanged: false };
  }

  updated.failureCount = circuit.failureCount + 1;

  if (shouldOpenCircuit(updated.failureCount)) {
    updated.state = "OPEN";
    updated.openedAt = now;
    updated.cooldownSeconds = CIRCUIT_CONFIG.COOLDOWN_SECONDS;
    updated.testRequestsProcessed = 0;
    updated.testSuccessCount = 0;
    return { circuit: updated, stateChanged: true, newState: "OPEN" };
  }

  return { circuit: updated, stateChanged: false };
}

// ─── Helpers ────────────────────────────────

function resetCircuit(circuit: CircuitState): CircuitState {
  return {
    ...circuit,
    state: "CLOSED",
    failureCount: 0,
    openedAt: null,
    halfOpenAt: null,
    cooldownSeconds: CIRCUIT_CONFIG.COOLDOWN_SECONDS,
    testRequestsProcessed: 0,
    testSuccessCount: 0,
  };
}

function reopenCircuit(circuit: CircuitState): CircuitState {
  return {
    ...circuit,
    state: "OPEN",
    openedAt: Date.now(),
    halfOpenAt: null,
    cooldownSeconds: getNextCooldown(circuit.cooldownSeconds),
    testRequestsProcessed: 0,
    testSuccessCount: 0,
  };
}

export function createDefaultCircuit(functionName: string): CircuitState {
  return {
    functionName,
    state: "CLOSED",
    failureCount: 0,
    lastFailureAt: null,
    openedAt: null,
    halfOpenAt: null,
    cooldownSeconds: CIRCUIT_CONFIG.COOLDOWN_SECONDS,
    testRequestsAllowed: CIRCUIT_CONFIG.HALF_OPEN_TEST_REQUESTS,
    testRequestsProcessed: 0,
    testSuccessCount: 0,
  };
}
