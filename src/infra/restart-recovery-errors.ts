/** Stale input provenance cannot authorize a resend in the current session. */
export class GatewayOperatorRecoveryOwnershipError extends Error {
  constructor(
    message = "Restart recovery operator source no longer owns this input.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayOperatorRecoveryOwnershipError";
  }
}
