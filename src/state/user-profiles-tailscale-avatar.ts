import {
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
} from "../shared/avatar-limits.js";
import type { UserProfileAvatarMime } from "./user-profiles.types.js";

const TAILSCALE_AVATAR_FETCH_TIMEOUT_MS = 5_000;
const TAILSCALE_AVATAR_MAX_REDIRECTS = 3;

export async function fetchTailscaleAvatar(
  url: string,
): Promise<{ bytes: Buffer; mime: UserProfileAvatarMime } | null> {
  try {
    // Keep the media runtime behind an actual avatar fetch.
    const [{ readRemoteMediaBuffer }, { fileTypeFromBuffer }] = await Promise.all([
      import("../media/fetch.js"),
      import("file-type"),
    ]);
    const loaded = await readRemoteMediaBuffer({
      url,
      maxBytes: MAX_USER_PROFILE_AVATAR_BYTES,
      maxRedirects: TAILSCALE_AVATAR_MAX_REDIRECTS,
      timeoutMs: TAILSCALE_AVATAR_FETCH_TIMEOUT_MS,
      responseHeaderTimeoutMs: TAILSCALE_AVATAR_FETCH_TIMEOUT_MS,
      readIdleTimeoutMs: TAILSCALE_AVATAR_FETCH_TIMEOUT_MS,
      requestInit: { headers: { Accept: USER_PROFILE_AVATAR_MIME_TYPES.join(",") } },
    });
    const mime = USER_PROFILE_AVATAR_MIME_TYPES.find(
      (candidate) => candidate === loaded.contentType,
    );
    const detected = await fileTypeFromBuffer(loaded.buffer);
    return mime && detected?.mime === mime ? { bytes: loaded.buffer, mime } : null;
  } catch {
    return null;
  }
}
