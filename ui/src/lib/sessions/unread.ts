/**
 * Owns each automatic acknowledgement through request settlement. Published
 * optimistic reads and rollbacks must not start another request while it is pending.
 */
export class SessionUnreadPatchGuard {
  private activeSessionKey = "";
  private activationObserved = false;
  private activationMarkedUnreadAt: number | undefined;
  private pendingPatch: object | null = null;

  beginActivation(activeSessionKey: string) {
    this.activeSessionKey = activeSessionKey.trim();
    this.activationObserved = false;
    this.activationMarkedUnreadAt = undefined;
    this.pendingPatch = null;
  }

  beginPatch(
    activeSessionKey: string,
    unread: boolean | undefined,
    markedUnreadAt?: number | null,
  ): (() => void) | null {
    const key = activeSessionKey.trim();
    const marker = markedUnreadAt ?? undefined;
    if (key !== this.activeSessionKey) {
      this.beginActivation(key);
    }
    if (!key || this.pendingPatch) {
      return null;
    }
    if (!this.activationObserved) {
      this.activationObserved = true;
      this.activationMarkedUnreadAt = marker;
    }
    if (unread === false) {
      if (marker !== undefined) {
        return null;
      }
      this.activationMarkedUnreadAt = undefined;
      return null;
    }
    if (marker !== undefined && marker !== this.activationMarkedUnreadAt) {
      return null;
    }
    if (unread !== true) {
      return null;
    }
    const claim = {};
    this.pendingPatch = claim;
    return () => {
      // A late completion from an earlier activation cannot release its successor.
      if (this.pendingPatch === claim) {
        this.pendingPatch = null;
      }
    };
  }
}
