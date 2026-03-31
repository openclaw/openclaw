/**
 * Single in-process issue time for the gateway shared token.
 * Not persisted; cleared on process restart.
 */
let tokenIssuedAtMs: number | undefined;
/** Avoid log spam: at most one expiry warning per process until token is re-issued. */
let gatewayTokenExpiryWarningEmitted = false;

export function setGatewayTokenIssuedAtNow(): void {
  tokenIssuedAtMs = Date.now();
  gatewayTokenExpiryWarningEmitted = false;
}

export function resetGatewayTokenIssuedAt(): void {
  tokenIssuedAtMs = undefined;
  gatewayTokenExpiryWarningEmitted = false;
}

export function getGatewayTokenIssuedAtMs(): number | undefined {
  return tokenIssuedAtMs;
}

export function isGatewayTokenPastExpiry(params: { expiryHours: number }): boolean {
  if (tokenIssuedAtMs === undefined) {
    return false;
  }
  const hours = params.expiryHours;
  if (!Number.isFinite(hours) || hours <= 0) {
    return false;
  }
  const maxMs = hours * 3_600_000;
  return Date.now() - tokenIssuedAtMs >= maxMs;
}

/**
 * Returns true at most once per process while the token remains past expiry.
 * Resets when {@link setGatewayTokenIssuedAtNow} or {@link resetGatewayTokenIssuedAt} runs.
 */
export function consumeGatewayTokenExpiryWarning(params: { expiryHours: number }): boolean {
  if (!isGatewayTokenPastExpiry(params)) {
    return false;
  }
  if (gatewayTokenExpiryWarningEmitted) {
    return false;
  }
  gatewayTokenExpiryWarningEmitted = true;
  return true;
}
