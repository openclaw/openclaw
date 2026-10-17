/**
 * Tracks a typing controller handed to a queued follow-up. While the follow-up
 * owns typing, dispatcher idle is deferred; the typing idle callback runs once it
 * settles.
 */
export function createTypingHandoff(notifyIdle: () => void, onCleanup: (() => void) | undefined) {
  let handedOff = false;
  let idleDeferred = false;
  return {
    isHandedOff: () => handedOff,
    deferIdle: () => {
      idleDeferred ||= handedOff;
      return handedOff;
    },
    onHandoff:
      onCleanup &&
      (() => {
        handedOff = true;
      }),
    onCleanup:
      onCleanup &&
      (() => {
        onCleanup();
        if (!handedOff) {
          return;
        }
        handedOff = false;
        if (idleDeferred) {
          idleDeferred = false;
          notifyIdle();
        }
      }),
  };
}
