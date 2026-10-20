import { ErrorCodes } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayReadRetryDelayMs } from "../gateway-availability.ts";

/**
 * Acknowledges unread state at most once per unread episode: the pending flag
 * clears when the server-confirmed read (unread=false) is observed, so fresh
 * activity while the session stays open re-acknowledges without patch loops.
 */
export class SessionUnreadPatchGuard {
  private activeSessionKey = "";
  private activationObserved = false;
  private activationMarkedUnreadAt: number | undefined;
  private requested = false;
  private pending: object | null = null;
  private observedRead = false;
  private retryAt = 0;
  private failures = 0;

  beginActivation(activeSessionKey: string) {
    this.activeSessionKey = activeSessionKey.trim();
    this.activationObserved = false;
    this.activationMarkedUnreadAt = undefined;
    this.requested = false;
    this.pending = null;
    this.observedRead = false;
    this.retryAt = 0;
    this.failures = 0;
  }

  shouldPatch(
    activeSessionKey: string,
    unread: boolean | undefined,
    markedUnreadAt?: number | null,
  ): boolean {
    const key = activeSessionKey.trim();
    const marker = markedUnreadAt ?? undefined;
    if (key !== this.activeSessionKey) {
      this.beginActivation(key);
    }
    if (!key) {
      return false;
    }
    if (!this.activationObserved) {
      this.activationObserved = true;
      this.activationMarkedUnreadAt = marker;
    }
    this.observedRead = unread === false && marker === undefined;
    // Optimistic reads and rollback publish synchronously before the request settles.
    if (this.pending) {
      return false;
    }
    if (unread === false) {
      // An optimistic read keeps the observed marker until the Gateway confirms it.
      // Clearing the latch here would let rollback synchronously dispatch a duplicate.
      if (marker !== undefined) {
        return false;
      }
      this.activationMarkedUnreadAt = undefined;
      this.requested = false;
      this.retryAt = 0;
      this.failures = 0;
      return false;
    }
    if (marker !== undefined && marker !== this.activationMarkedUnreadAt) {
      return false;
    }
    if (unread !== true || this.requested || Date.now() < this.retryAt) {
      return false;
    }
    this.requested = true;
    this.pending = {};
    return true;
  }

  /** Bind settlement to this activation, including a return to the same session. */
  settlePatch() {
    const pending = this.pending;
    return (succeeded: boolean, error?: unknown) => {
      if (pending !== this.pending) {
        return;
      }
      this.pending = null;
      this.requested = succeeded ? !this.observedRead : isPermanentUnreadAckFailure(error);
      if (succeeded) {
        this.retryAt = 0;
        this.failures = 0;
      } else if (error !== undefined && !this.requested) {
        const delay = resolveGatewayReadRetryDelayMs(error, this.failures++);
        this.retryAt = Date.now() + Math.ceil(delay * (1 + Math.random() * 0.2));
      }
    };
  }
}

/** Invalid state and missing access persist; transport failures may succeed on retry. */
function isPermanentUnreadAckFailure(error: unknown): boolean {
  const code = asNullableRecord(error)?.gatewayCode;
  return (
    code === ErrorCodes.INVALID_REQUEST ||
    code === ErrorCodes.FORBIDDEN ||
    code === ErrorCodes.APPROVAL_NOT_FOUND
  );
}
