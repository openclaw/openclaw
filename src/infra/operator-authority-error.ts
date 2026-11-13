import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";

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
  const kind = reason.startsWith("closure-") ? "execution" : "source";
  return Object.defineProperty(
    new Error(
      `operator ${kind} authority is no longer active. Reconnect to the Gateway, then resend your message. If access is denied, ask an administrator to restore it.`,
    ),
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
