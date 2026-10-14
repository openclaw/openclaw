import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";

// Renew the invitation once for the Reddit/Discord/X design, independently of app updates.
export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite:v2";

// A failed save must still dismiss across sidebar remounts in this page.
let unpersistedDismissal = false;

export function isCommunityInviteEligible(): boolean {
  if (unpersistedDismissal) {
    return false;
  }
  try {
    // Any stored marker, including malformed content, suppresses the invite.
    return (
      getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY) === null &&
      getSafeSessionStorage()?.getItem(COMMUNITY_INVITE_KEY) == null
    );
  } catch {
    return false;
  }
}

export function dismissCommunityInvite(): Result<void, "storage-unavailable"> {
  unpersistedDismissal = true;
  try {
    const storage = getSafeLocalStorage();
    if (storage) {
      storage.setItem(COMMUNITY_INVITE_KEY, JSON.stringify({ dismissedAtMs: Date.now() }));
      unpersistedDismissal = false;
      return ok(undefined);
    }
  } catch {}
  // A quota-failed permanent save must still survive recovery reloads in this tab.
  // Keep reporting the failure because closing the tab loses this marker.
  try {
    getSafeSessionStorage()?.setItem(COMMUNITY_INVITE_KEY, "dismissed");
  } catch {}
  return err("storage-unavailable");
}
