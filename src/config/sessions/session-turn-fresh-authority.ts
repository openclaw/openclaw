import {
  acceptSessionSourceValidation,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
} from "./session-source-authority.js";

/** Accept fresh-message transaction facts before retaining their final commit guards. */
export function acceptSessionTurnFreshAuthority(
  facts: Record<string, unknown>,
  sources: readonly (PreparedSessionSourceAuthority | undefined)[],
  mentionGuards: readonly ((() => void) | undefined)[],
  commitGuards: Set<() => void>,
): void {
  const source = typeof facts.index === "number" ? sources[facts.index] : undefined;
  const mentionGuard = typeof facts.index === "number" ? mentionGuards[facts.index] : undefined;
  if (!source && !mentionGuard) {
    throw new Error("Session turn omitted its fresh-message authority");
  }
  if (source) {
    acceptSessionSourceValidation(
      source,
      // SAFETY: The paired worker read these facts in the current transaction.
      facts.sourceValidation as SessionSourceValidation,
    );
    source.assertCurrent();
    commitGuards.add(source.assertCurrent);
  }
  if (mentionGuard) {
    mentionGuard();
    commitGuards.add(mentionGuard);
  }
}
