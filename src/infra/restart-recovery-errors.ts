/** Codeless so surfaces that append error codes keep the existing user-facing text. */
export class GatewayDispatchUnavailableError extends Error {
  constructor(
    method: string,
    readonly retryable: boolean,
  ) {
    super(`Gateway instance dispatch unavailable for ${method}`);
    this.name = "GatewayDispatchUnavailableError";
  }
}

/** A committed authorization change retires the interrupted input, not its session. */
export class GatewayOperatorRecoveryAuthorizationError extends Error {
  constructor(
    message = "Restart recovery operator authority changed; start a new user turn.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayOperatorRecoveryAuthorizationError";
  }
}
