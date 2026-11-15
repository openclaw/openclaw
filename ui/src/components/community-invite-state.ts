import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { getSafeLocalStorage } from "../local-storage.ts";

// Keep existing browser-origin dismissals across invitation design changes.
export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite:v2";

// A failed save must still dismiss across sidebar remounts in this page.
let unpersistedDismissal = false;

export function isCommunityInviteEligible(): boolean {
  if (unpersistedDismissal) {
    return false;
  }
  try {
    // Any stored marker, including malformed content, suppresses the invite.
    return getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY) === null;
  } catch {
    return false;
  }
}

export function dismissCommunityInvite(): Result<void, "storage-unavailable"> {
  unpersistedDismissal = true;
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return err("storage-unavailable");
    }
    storage.setItem(COMMUNITY_INVITE_KEY, JSON.stringify({ dismissedAtMs: Date.now() }));
    unpersistedDismissal = false;
    return ok(undefined);
  } catch {
    return err("storage-unavailable");
  }
}
