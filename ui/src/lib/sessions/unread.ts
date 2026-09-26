import { ErrorCodes } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

/** Keeps automatic read acknowledgement owned through optimistic updates and settlement. */
export class SessionUnreadPatchGuard {
  private activeSessionKey = "";
  private activationObserved = false;
  private activationMarkedUnreadAt: number | undefined;
  private requested = false;
  private pendingPatch: object | null = null;

  beginActivation(activeSessionKey: string) {
    this.activeSessionKey = activeSessionKey.trim();
    this.activationObserved = false;
    this.activationMarkedUnreadAt = undefined;
    this.requested = false;
    this.pendingPatch = null;
  }

  beginPatch(
    activeSessionKey: string,
    unread: boolean | undefined,
    markedUnreadAt?: number | null,
  ): ((error?: unknown) => boolean) | null {
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
      this.requested = false;
      return null;
    }
    if (marker !== undefined && marker !== this.activationMarkedUnreadAt) {
      return null;
    }
    if (unread !== true || this.requested) {
      return null;
    }
    const claim = {};
    this.pendingPatch = claim;
    return (error?: unknown) => {
      // Old activations and repeated completions cannot release a newer request.
      if (this.pendingPatch !== claim) {
        return false;
      }
      this.pendingPatch = null;
      const code = asNullableRecord(error)?.gatewayCode;
      this.requested =
        code === ErrorCodes.INVALID_REQUEST ||
        code === ErrorCodes.FORBIDDEN ||
        code === ErrorCodes.APPROVAL_NOT_FOUND;
      return true;
    };
  }
}
