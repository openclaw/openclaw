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
    revocation.abort(reason);
    unsubscribe();
  };
  const assertCurrent = () => {
    revocation.signal.throwIfAborted();
    try {
      // The channel assertion owns the revocation error; the grant signal is a backstop.
      params.assertCurrent();
      params.signal?.throwIfAborted();
    } catch (error) {
      revoke(error);
      throw error;
    }
  };
  const recheck = () => {
    try {
      assertCurrent();
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
    retain: () => {
      assertCurrent();
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
