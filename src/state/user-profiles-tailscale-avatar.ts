import type { FetchLike } from "../media/fetch.js";
import {
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
} from "../shared/avatar-limits.js";
import type { UserProfileAvatarMime } from "./user-profiles.types.js";

const TAILSCALE_AVATAR_FETCH_TIMEOUT_MS = 5_000;
const TAILSCALE_AVATAR_MAX_REDIRECTS = 3;

export type TailscaleAvatarFetchOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function toAvatarMime(value: string | undefined): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.includes(value as UserProfileAvatarMime)
    ? (value as UserProfileAvatarMime)
    : null;
}

export async function fetchTailscaleAvatar(
  url: string,
  options: TailscaleAvatarFetchOptions,
): Promise<{ bytes: Buffer; mime: UserProfileAvatarMime } | null> {
  try {
    const timeoutMs = options.timeoutMs ?? TAILSCALE_AVATAR_FETCH_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl;
    // Keep the media runtime behind an actual avatar fetch.
    const [{ readRemoteMediaBuffer }, { fileTypeFromBuffer }] = await Promise.all([
      import("../media/fetch.js"),
      import("file-type"),
    ]);
    const loaded = await readRemoteMediaBuffer({
      url,
      fetchImpl,
      maxBytes: MAX_USER_PROFILE_AVATAR_BYTES,
      maxRedirects: TAILSCALE_AVATAR_MAX_REDIRECTS,
      timeoutMs,
      responseHeaderTimeoutMs: timeoutMs,
      readIdleTimeoutMs: timeoutMs,
      requestInit: { headers: { Accept: USER_PROFILE_AVATAR_MIME_TYPES.join(",") } },
    });
    const mime = toAvatarMime(loaded.contentType);
    const detected = await fileTypeFromBuffer(loaded.buffer);
    return mime && detected?.mime === mime ? { bytes: loaded.buffer, mime } : null;
  } catch {
    return null;
  }
}
