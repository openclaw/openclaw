/**
 * Tracks the last model-pricing bootstrap/refresh failure for health surfaces (#79599).
 * Remote catalog fetches are best-effort; when they fail entirely we still surface
 * `degraded` while the gateway stays otherwise healthy.
 */

let lastBootstrapFailure: { message: string; at: number } | null = null;

export type GatewayModelPricingBootstrapHealth =
  | { state: "ok" }
  | { state: "degraded"; detail: string; lastFailureAt: number };

export function recordGatewayModelPricingBootstrapFailure(message: string): void {
  lastBootstrapFailure = { message, at: Date.now() };
}

export function clearGatewayModelPricingBootstrapFailure(): void {
  lastBootstrapFailure = null;
}

export function getGatewayModelPricingBootstrapHealth(): GatewayModelPricingBootstrapHealth {
  if (!lastBootstrapFailure) {
    return { state: "ok" };
  }
  return {
    state: "degraded",
    detail: lastBootstrapFailure.message,
    lastFailureAt: lastBootstrapFailure.at,
  };
}

/** @internal */
export function __resetGatewayModelPricingBootstrapHealthForTest(): void {
  lastBootstrapFailure = null;
}
