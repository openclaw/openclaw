import { isRecord } from "@openclaw/normalization-core/record-coerce";

export class SessionDeliveryGenerationRevokedError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_REVOKED";
  constructor() {
    super("The original session generation no longer accepts this delivery.");
    this.name = "SessionDeliveryGenerationRevokedError";
  }
}

export class SessionDeliveryGenerationUnavailableError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_UNAVAILABLE";
  constructor(options?: ErrorOptions) {
    super(
      "Session delivery generation is unavailable; retry after session storage is ready.",
      options,
    );
    this.name = "SessionDeliveryGenerationUnavailableError";
  }
}

export const isSessionDeliveryGenerationRevokedError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_REVOKED";
export const isSessionDeliveryGenerationUnavailableError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_UNAVAILABLE";

/** Walks wrapper causes; revocation wins because a fresh lease cannot restore that generation. */
export function classifySessionDeliveryGenerationRefusal(
  error: unknown,
): "unavailable" | "revoked" | undefined {
  let refusal: "unavailable" | undefined;
  for (let current = error, depth = 0; isRecord(current) && depth < 8; depth++) {
    if (isSessionDeliveryGenerationRevokedError(current)) {
      return "revoked";
    }
    refusal ??= isSessionDeliveryGenerationUnavailableError(current) ? "unavailable" : undefined;
    current = current.cause;
  }
  return refusal;
}
