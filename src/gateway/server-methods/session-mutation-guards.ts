import type { SessionMutationAuthorization } from "./types.js";

/** Keep the host lifetime and operator target policy on the same commit boundary. */
export function withSessionMutationCommitGuard(
  authorization: SessionMutationAuthorization | undefined,
  assertCommitAllowed: (() => void) | undefined,
  assertExpectedProfile: (() => void) | undefined,
): SessionMutationAuthorization | undefined {
  if (!assertCommitAllowed && !assertExpectedProfile) {
    return authorization;
  }
  // Committed input keeps its original host and session authority. A later
  // account selection change cannot revoke custody already transferred to it.
  const assertAdmittedInputCurrent = () => {
    assertCommitAllowed?.();
    authorization?.assertCurrent();
  };
  return {
    ...authorization,
    assertAdmittedInputCurrent,
    assertCurrent: () => {
      assertExpectedProfile?.();
      assertAdmittedInputCurrent();
    },
    assertTargetCurrent: (target) => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertTargetCurrent(target);
    },
  };
}
