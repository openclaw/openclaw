import type { SsrFPolicy } from "../infra/net/ssrf.js";

export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
  optimizeImages?: boolean;
  ssrfPolicy?: SsrFPolicy;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[];
  optimizeImages?: boolean;
  ssrfPolicy?: SsrFPolicy;
};

export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[],
): readonly string[] | undefined {
  return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}

export function buildOutboundMediaLoadOptions(
  params: OutboundMediaLoadParams = {},
): OutboundMediaLoadOptions {
  const localRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots ? { localRoots } : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    ...(params.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
  };
}
