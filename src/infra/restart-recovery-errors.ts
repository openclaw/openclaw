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

/** A refused recovery admission retires the interrupted input, not its session. */
export class GatewayOperatorRecoveryAuthorizationError extends Error {
  constructor(
    message = "Restart recovery could not admit this input. Start a new user turn.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayOperatorRecoveryAuthorizationError";
  }
}
