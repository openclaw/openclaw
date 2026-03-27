export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;

export type OutboundMediaAccess = {
  localRoots?: readonly string[];
  readFile?: OutboundMediaReadFile;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: OutboundMediaReadFile;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  readFile?: (filePath: string) => Promise<Buffer>;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
  hostReadCapability?: boolean;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[] | "any",
): readonly string[] | "any" | undefined {
  if (mediaLocalRoots === "any") {
    return mediaLocalRoots;
  }
  // Preserve an explicit empty allowlist as deny-all instead of falling back
  // to default local media roots.
  return mediaLocalRoots === undefined ? undefined : mediaLocalRoots;
}

export function resolveOutboundMediaAccess(
  params: {
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: OutboundMediaReadFile;
  } = {},
): OutboundMediaAccess | undefined {
  const resolvedLocalRoots = resolveOutboundMediaLocalRoots(
    params.mediaAccess?.localRoots ?? params.mediaLocalRoots,
  );
  const localRoots = resolvedLocalRoots === "any" ? undefined : resolvedLocalRoots;
  const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
  const workspaceDir = params.mediaAccess?.workspaceDir;
  if (localRoots === undefined && !readFile && !workspaceDir) {
    return undefined;
  }
  return {
    ...(localRoots !== undefined ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

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
  if (readFile) {
    if (localRoots === undefined) {
      throw new Error(
        'Host media read requires explicit localRoots. Pass mediaAccess.localRoots or opt in with localRoots: "any".',
      );
    }
    return {
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      localRoots,
      readFile,
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
      ...(params.requestInit ? { requestInit: params.requestInit } : {}),
      ...(params.trustExplicitProxyDns !== undefined
        ? { trustExplicitProxyDns: params.trustExplicitProxyDns }
        : {}),
      hostReadCapability: true,
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots !== undefined ? { localRoots } : {}),
    ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.requestInit ? { requestInit: params.requestInit } : {}),
    ...(params.trustExplicitProxyDns !== undefined
      ? { trustExplicitProxyDns: params.trustExplicitProxyDns }
      : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}
