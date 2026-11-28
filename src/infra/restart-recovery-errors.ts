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
