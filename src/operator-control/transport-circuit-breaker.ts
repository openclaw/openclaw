export type OperatorTransportCircuitName = "2tony-http" | "deb-http" | "delegated-http";

export type OperatorTransportCircuitSnapshot = {
  transport: OperatorTransportCircuitName;
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  threshold: number;
  cooldownMs: number;
  openedAt: number | null;
  lastFailureAt: number | null;
};

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60_000;

type MutableOperatorTransportCircuit = OperatorTransportCircuitSnapshot;

const circuits = new Map<OperatorTransportCircuitName, MutableOperatorTransportCircuit>();

export class OperatorTransportCircuitOpenError extends Error {
  readonly transport: OperatorTransportCircuitName;
  readonly retryAfterMs: number;

  constructor(transport: OperatorTransportCircuitName, retryAfterMs: number) {
    super(`transport circuit open for ${transport}; retry after ${retryAfterMs}ms`);
    this.name = "OperatorTransportCircuitOpenError";
    this.transport = transport;
    this.retryAfterMs = retryAfterMs;
  }
}

function getCircuit(transport: OperatorTransportCircuitName): MutableOperatorTransportCircuit {
  const existing = circuits.get(transport);
  if (existing) {
    return existing;
  }
  const created: MutableOperatorTransportCircuit = {
    transport,
    state: "closed",
    consecutiveFailures: 0,
    threshold: DEFAULT_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    openedAt: null,
    lastFailureAt: null,
  };
  circuits.set(transport, created);
  return created;
}

function cloneCircuit(circuit: MutableOperatorTransportCircuit): OperatorTransportCircuitSnapshot {
  return { ...circuit };
}

export function resetOperatorTransportCircuitBreakers(): void {
  circuits.clear();
}

export function getOperatorTransportCircuitSnapshot(
  transport: OperatorTransportCircuitName,
): OperatorTransportCircuitSnapshot {
  return cloneCircuit(getCircuit(transport));
}

export function listOperatorTransportCircuitSnapshots(): OperatorTransportCircuitSnapshot[] {
  return (["2tony-http", "deb-http", "delegated-http"] as const).map((transport) =>
    getOperatorTransportCircuitSnapshot(transport),
  );
}

export function assertOperatorTransportCircuitClosed(
  transport: OperatorTransportCircuitName,
  now = Date.now(),
): void {
  const circuit = getCircuit(transport);
  if (circuit.state !== "open") {
    return;
  }
  const openedAt = circuit.openedAt ?? now;
  const elapsed = now - openedAt;
  if (elapsed >= circuit.cooldownMs) {
    circuit.state = "half-open";
    return;
  }
  throw new OperatorTransportCircuitOpenError(transport, circuit.cooldownMs - elapsed);
}

export function recordOperatorTransportDispatchSuccess(
  transport: OperatorTransportCircuitName,
): OperatorTransportCircuitSnapshot {
  const circuit = getCircuit(transport);
  circuit.state = "closed";
  circuit.consecutiveFailures = 0;
  circuit.openedAt = null;
  circuit.lastFailureAt = null;
  return cloneCircuit(circuit);
}

export function recordOperatorTransportDispatchFailure(
  transport: OperatorTransportCircuitName,
  now = Date.now(),
): OperatorTransportCircuitSnapshot {
  const circuit = getCircuit(transport);
  circuit.consecutiveFailures += 1;
  circuit.lastFailureAt = now;
  if (circuit.state === "half-open" || circuit.consecutiveFailures >= circuit.threshold) {
    circuit.state = "open";
    circuit.openedAt = now;
  }
  return cloneCircuit(circuit);
}
