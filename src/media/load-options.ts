import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

/** Host callback used to read an already-authorized outbound media file. */
export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;

/** Host-provided file access used when a runtime can read outbound media from local disk. */
export type OutboundMediaAccess = {
  localRoots?: readonly string[];
  readFile?: OutboundMediaReadFile;
  /** Agent workspace directory for resolving relative media paths. */
  workspaceDir?: string;
  /** Operator hostname deny list applied to remote outbound media downloads. */
  blockedHostnames?: readonly string[];
};

/**
 * Adds the operator's `tools.web.fetch.ssrfPolicy.blockedHostnames` to outbound media access.
 * Only the deny list applies; web_fetch's private-network opt-ins stay out of outbound media.
 */
export function resolveOutboundMediaAccessForConfig(
  cfg: OpenClawConfig | undefined,
  mediaAccess?: OutboundMediaAccess,
): OutboundMediaAccess | undefined {
  const blockedHostnames = cfg?.tools?.web?.fetch?.ssrfPolicy?.blockedHostnames;
  return blockedHostnames?.length ? { ...mediaAccess, blockedHostnames } : mediaAccess;
}

/** Legacy and current knobs accepted by outbound media loaders before normalization. */
type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: OutboundMediaReadFile;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative media paths. */
  workspaceDir?: string;
};

/** Normalized outbound media loader options consumed by fetch/local media helpers. */
type OutboundMediaLoadOptions = Omit<
  OutboundMediaLoadParams,
  "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
> & {
  localRoots?: readonly string[] | "any";
  readFile?: OutboundMediaReadFile;
  hostReadCapability?: boolean;
  ssrfPolicy?: SsrFPolicy;
};

/** Normalizes empty root lists while preserving the explicit all-roots opt-in sentinel. */
export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[] | "any",
): readonly string[] | "any" | undefined {
  if (mediaLocalRoots === "any") {
    return mediaLocalRoots;
  }
  return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}

/** Collapses legacy read/root parameters into the current host media access shape. */
export function resolveOutboundMediaAccess(
  params: {
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: OutboundMediaReadFile;
  } = {},
): OutboundMediaAccess | undefined {
  const resolvedLocalRoots = resolveOutboundMediaLocalRoots(
    params.mediaAccess?.localRoots ?? params.mediaLocalRoots,
  );
  const localRoots = resolvedLocalRoots === "any" ? undefined : resolvedLocalRoots;
  const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
  const workspaceDir = params.mediaAccess?.workspaceDir;
  const blockedHostnames = params.mediaAccess?.blockedHostnames?.length
    ? params.mediaAccess.blockedHostnames
    : undefined;
  if (!localRoots && !readFile && !workspaceDir && !blockedHostnames) {
    return undefined;
  }
  return {
    ...(localRoots ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(blockedHostnames ? { blockedHostnames } : {}),
  };
}

/** Builds the canonical media load options shared by outbound attachment paths. */
export function buildOutboundMediaLoadOptions(
  params: OutboundMediaLoadParams = {},
): OutboundMediaLoadOptions {
  const explicitLocalRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
  const mediaAccess = resolveOutboundMediaAccess({
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: explicitLocalRoots === "any" ? undefined : explicitLocalRoots,
    mediaReadFile: params.mediaAccess?.readFile ? undefined : params.mediaReadFile,
  });
  const workspaceDir = mediaAccess?.workspaceDir ?? params.workspaceDir;
  const readFile = mediaAccess?.readFile ?? params.mediaReadFile;
  const localRoots = mediaAccess?.localRoots ?? explicitLocalRoots;
  const blockedHostnames = mediaAccess?.blockedHostnames;
  // Host reads must declare a root boundary so local file access cannot silently widen.
  if (readFile && !localRoots) {
    throw new Error(
      'Host media read requires explicit localRoots. Pass mediaAccess.localRoots or opt in with localRoots: "any".',
    );
  }
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots ? { localRoots } : {}),
    ...(readFile ? { readFile, hostReadCapability: true } : {}),
    ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.requestInit ? { requestInit: params.requestInit } : {}),
    ...(params.trustExplicitProxyDns !== undefined
      ? { trustExplicitProxyDns: params.trustExplicitProxyDns }
      : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(blockedHostnames ? { ssrfPolicy: { blockedHostnames: [...blockedHostnames] } } : {}),
  };
}
