import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("proxy-probe");

/**
 * Circuit breaker for HTTP proxy connectivity.
 *
 * Tracks proxy reachability based on actual fetch outcomes. When a proxy
 * fetch fails with a connection error, the circuit opens and subsequent
 * requests fall back to direct fetch during a cooldown window.
 *
 * State transitions:
 *   CLOSED  → fetch succeeds   → stay CLOSED (proxy usable)
 *   CLOSED  → fetch conn error → OPEN (proxy bypassed)
 *   OPEN    → cooldown expires  → HALF_OPEN (next fetch tries proxy)
 *   HALF_OPEN → fetch succeeds  → CLOSED
 *   HALF_OPEN → fetch fails     → OPEN (reset cooldown)
 */

type CircuitState = "closed" | "open" | "half_open";

const INITIAL_COOLDOWN_MS = 10_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const COOLDOWN_FACTOR = 2;

type ProxyCircuit = {
  state: CircuitState;
  lastFailAt: number;
  cooldownMs: number;
  consecutiveFailures: number;
};

const circuits = new Map<string, ProxyCircuit>();

function normalizeKey(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return proxyUrl;
  }
}

function getCircuit(proxyUrl: string): ProxyCircuit {
  const key = normalizeKey(proxyUrl);
  let circuit = circuits.get(key);
  if (!circuit) {
    circuit = {
      state: "closed",
      lastFailAt: 0,
      cooldownMs: INITIAL_COOLDOWN_MS,
      consecutiveFailures: 0,
    };
    circuits.set(key, circuit);
  }
  return circuit;
}

/**
 * Returns true if the proxy circuit is currently open (proxy known-bad)
 * and the cooldown has not yet expired. When the cooldown expires, returns
 * false so the next fetch attempt can re-probe the proxy.
 */
export function isProxyCircuitOpen(proxyUrl: string): boolean {
  const circuit = getCircuit(proxyUrl);
  if (circuit.state === "closed") {
    return false;
  }
  const elapsed = Date.now() - circuit.lastFailAt;
  if (elapsed >= circuit.cooldownMs) {
    // Cooldown expired — allow one probe attempt.
    circuit.state = "half_open";
    return false;
  }
  return true;
}

/** Record a successful proxy fetch — close the circuit. */
export function recordProxySuccess(proxyUrl: string): void {
  const circuit = getCircuit(proxyUrl);
  if (circuit.state === "closed") {
    return;
  }
  const key = normalizeKey(proxyUrl);
  log.info?.(`proxy ${key} is reachable again`);
  circuit.state = "closed";
  circuit.consecutiveFailures = 0;
  circuit.cooldownMs = INITIAL_COOLDOWN_MS;
}

/** Record a proxy connection failure — open the circuit. */
export function recordProxyFailure(proxyUrl: string): void {
  const circuit = getCircuit(proxyUrl);
  const key = normalizeKey(proxyUrl);
  if (circuit.state === "closed") {
    log.warn?.(`proxy ${key} is unreachable — falling back to direct connection`);
  }
  circuit.state = "open";
  circuit.consecutiveFailures += 1;
  circuit.cooldownMs = Math.min(
    INITIAL_COOLDOWN_MS * COOLDOWN_FACTOR ** (circuit.consecutiveFailures - 1),
    MAX_COOLDOWN_MS,
  );
  circuit.lastFailAt = Date.now();
}

const PROXY_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Check if an error is a proxy connection failure (vs. an application-level error). */
export function isProxyConnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && PROXY_CONNECT_ERROR_CODES.has(code)) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: string }).code;
    if (typeof causeCode === "string" && PROXY_CONNECT_ERROR_CODES.has(causeCode)) {
      return true;
    }
  }
  return false;
}

/** Reset all circuit state (for tests). */
export function resetProxyCircuits(): void {
  circuits.clear();
}
