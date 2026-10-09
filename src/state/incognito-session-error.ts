import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const IncognitoSessionEndedError = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionEndedError"),
  () =>
    class IncognitoEndedError extends Error {
      readonly code = "INCOGNITO_SESSION_ENDED";
      constructor(options?: ErrorOptions) {
        super("Incognito session ended. Create a new incognito session to continue.", options);
        this.name = "IncognitoSessionEndedError";
      }
    },
);
export type IncognitoSessionEndedError = InstanceType<typeof IncognitoSessionEndedError>;

/**
 * Shared by the host and SDK graphs so legacy adapters retain the actionable refusal.
 * @internal Knip production exception; P7d removes this tag when it installs sync refusal preflight.
 */
export const IncognitoSessionSyncAccessError = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionSyncAccessError"),
  () =>
    class IncognitoSyncAccessError extends Error {
      readonly code = "INCOGNITO_SESSION_SYNC_ACCESS";

      constructor(method: string, replacement: string) {
        super(
          `${method} cannot access an incognito session synchronously. Await ${replacement} instead.`,
        );
        this.name = "IncognitoSessionSyncAccessError";
      }
    },
);

/** An ended actor or unsupported sync access is never an empty or successfully updated session. */
export function rethrowIncognitoSessionError(error: unknown): void {
  if (
    collectNestedErrorCandidates(error).some(
      (candidate) =>
        candidate instanceof IncognitoSessionSyncAccessError ||
        candidate instanceof IncognitoSessionEndedError,
    )
  ) {
    throw error;
  }
}
