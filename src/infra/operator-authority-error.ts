import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import {
  gatewayOperatorAccessError,
  type GatewayOperatorAccessCause,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export class GatewayOperatorAccessDeniedError extends Error {
  constructor(readonly accessCause: GatewayOperatorAccessCause = "policy-check-failed") {
    super(gatewayOperatorAccessError(accessCause).message);
    this.name = "GatewayOperatorAccessDeniedError";
  }
}

/** The admitting request ended before a retained plugin operation could finish. */
export const GatewayRequestAuthorityExpiredError = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayRequestAuthorityExpiredError"),
  () =>
    class extends Error {
      constructor() {
        super("Gateway request authority expired");
      }
    },
);

/** A failed policy evaluation refuses this operation without revoking its source. */
export const GatewayOperatorAccessUnavailableError = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayOperatorAccessUnavailableError"),
  () =>
    class extends Error {
      constructor() {
        super("Gateway access policy is unavailable; retry the operation.");
        this.name = "GatewayOperatorAccessUnavailableError";
      }
    },
);

export function isOperatorAuthorityUnavailable(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof GatewayOperatorAccessUnavailableError,
  );
}

type OperatorAuthorityFailure = {
  operatorAuthorityReason:
    | "source-invalidated"
    | "gateway-identity-retired"
    | "closure-released"
    | "closure-revoked";
  operatorAuthorityCheck:
    | "source-current"
    | "source-revocation"
    | "gateway-current"
    | "before-sources"
    | "after-sources";
  operatorAuthorityAgeMs: number;
};

const failureMetadata = Symbol.for("openclaw.operator-authority-failure");

export function createOperatorAuthorityInactiveError(
  reason: OperatorAuthorityFailure["operatorAuthorityReason"],
  check: OperatorAuthorityFailure["operatorAuthorityCheck"],
  capturedAt: number,
): Error {
  return Object.defineProperty(
    new Error("Operator execution ended. Reconnect to the Gateway, then resend your message."),
    failureMetadata,
    {
      value: Object.freeze({
        operatorAuthorityReason: reason,
        operatorAuthorityCheck: check,
        operatorAuthorityAgeMs: Math.max(0, Math.floor(performance.now() - capturedAt)),
      } satisfies OperatorAuthorityFailure),
    },
  );
}

/** Preserve owner facts through sandbox/lease wrappers and duplicate module copies. */
export function readOperatorAuthorityFailure(error: unknown): OperatorAuthorityFailure | undefined {
  for (const cause of collectNestedErrorCandidates(error)) {
    try {
      const descriptor: TypedPropertyDescriptor<OperatorAuthorityFailure> | undefined =
        Object.getOwnPropertyDescriptor(cause, failureMetadata);
      if (descriptor?.value) {
        return descriptor.value;
      }
    } catch {
      // Opaque unrelated causes must not break lane diagnostics.
    }
  }
  return undefined;
}
