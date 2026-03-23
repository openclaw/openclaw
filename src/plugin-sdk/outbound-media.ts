import { loadWebMedia } from "./web-media.js";

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
};

/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(mediaUrl, {
    maxBytes: options.maxBytes,
    localRoots: options.mediaLocalRoots,
  });
}
