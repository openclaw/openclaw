import { adoptTailscaleProfileAvatar } from "../../../state/user-profiles.js";
import { sleep } from "../../../utils/sleep.js";
import { formatForLog } from "../../ws-log.js";

/**
 * Backoff between detached GitHub identity sync retries after the first
 * connect-time attempt fails; bounded so a wedged identity never loops
 * (#141615).
 */
const IDENTITY_SYNC_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/**
 * Runs the detached GitHub identity sync with a bounded backoff so a transient
 * quota or network failure self-heals without client action. Cancellation
 * (connection-work abort) ends the loop without another retry (#141615).
 */
export async function syncGitHubIdentityWithBackoff<T>(
  sync: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await sync();
    } catch (error) {
      const delay = IDENTITY_SYNC_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw error;
      }
      await sleep(delay, signal);
    }
  }
}

/**
 * Adopts a Tailscale profile avatar when the authenticated profile has none,
 * swallowing failures behind a warn line so avatar cosmetics never fail the
 * surrounding connect tail.
 */
export async function adoptTailscaleAvatarIfMissing(params: {
  profileId: string;
  hasAvatar?: boolean;
  profilePic?: string;
  adoptTailscaleProfileAvatar: typeof adoptTailscaleProfileAvatar;
  onAdopted: (profileId: string, updatedAt: number) => void;
  warn: (message: string) => void;
}): Promise<void> {
  if (params.hasAvatar || !params.profilePic) {
    return;
  }
  try {
    const updated = await params.adoptTailscaleProfileAvatar(params.profileId, params.profilePic);
    if (!updated.avatarMime) {
      return;
    }
    params.onAdopted(updated.id, updated.updatedAt);
  } catch (error) {
    params.warn(`Tailscale avatar adoption failed: ${formatForLog(error)}`);
  }
}
