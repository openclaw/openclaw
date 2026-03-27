import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { loadWebMedia } from "./web-media.js";

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
  ssrfPolicy?: SsrFPolicy;
};

/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(mediaUrl, {
    maxBytes: options.maxBytes,
    localRoots: options.mediaLocalRoots,
    ssrfPolicy: options.ssrfPolicy,
  });
}
