import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { onOperatorRolePolicyChanged } from "./operator-role-policy.js";

/**
 * Channel analogue of the Gateway revocation signal. Retained work subscribes to committed
 * profile, link and role changes; every check latches a failure into the same signal, so
 * work that missed a notification still settles at its next admission check.
 */
export function createChannelOperatorRevocation(params: {
  profileId: string;
  assertCurrent: () => void;
  assertCurrentForRecheck?: () => void;
  signal?: AbortSignal;
}) {
  const revocation = new AbortController();
  const subscriptions: Array<() => void> = [];
  let references = 0;
  const unsubscribe = () => {
    for (const release of subscriptions.splice(0)) {
      release();
    }
  };
  const revoke = (reason: unknown) => {
    if (!revocation.signal.aborted) {
      revocation.abort(reason);
    }
    unsubscribe();
  };
  const assertSource = (check: () => void) => {
    revocation.signal.throwIfAborted();
    try {
      // The channel assertion owns the revocation error; the grant signal is a backstop.
      check();
      params.signal?.throwIfAborted();
    } catch (error) {
      revoke(error);
      throw error;
    }
  };
  const assertCurrent = () => assertSource(params.assertCurrent);
  const assertCurrentForRecheck = () =>
    assertSource(params.assertCurrentForRecheck ?? params.assertCurrent);
  const recheck = () => {
    try {
      // Notifications only revalidate retained authority; no privileged effect occurs here.
      assertCurrentForRecheck();
    } catch {
      // The latched signal owns cancellation; notification must reach other executions.
    }
  };
  const subscribe = () => {
    subscriptions.push(
      onUserProfilesChanged(recheck),
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "config" || change.profileId === params.profileId) {
          recheck();
        }
      }),
    );
    const source = params.signal;
    if (source) {
      const onAbort = () => recheck();
      source.addEventListener("abort", onAbort, { once: true });
      subscriptions.push(() => source.removeEventListener("abort", onAbort));
    }
  };
  return {
    signal: revocation.signal,
    assertCurrent,
    assertCurrentForRecheck,
    retain: () => {
      // A lifetime hold preserves existing work; execution still checks the live source.
      assertCurrentForRecheck();
      if (references++ === 0) {
        subscribe();
      }
      let released = false;
      return () => {
        if (!released) {
          released = true;
          if (--references === 0) {
            unsubscribe();
          }
        }
      };
    },
  };
}
