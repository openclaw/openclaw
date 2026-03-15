import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
import type { FetchLike } from "./fetch.js";

export type OutboundMediaFetchOptions = {
  fetchImpl?: FetchLike;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  fallbackDispatcherPolicy?: PinnedDispatcherPolicy;
  shouldRetryFetchError?: (error: unknown) => boolean;
};

export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
  optimizeImages?: boolean;
} & OutboundMediaFetchOptions;

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[];
  optimizeImages?: boolean;
} & OutboundMediaFetchOptions;

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
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
    ...(params.fallbackDispatcherPolicy
      ? { fallbackDispatcherPolicy: params.fallbackDispatcherPolicy }
      : {}),
    ...(params.shouldRetryFetchError
      ? { shouldRetryFetchError: params.shouldRetryFetchError }
      : {}),
  };
}
