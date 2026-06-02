/** Host-side file reader injected only when local media roots explicitly allow reads. */
export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;

export type OutboundMediaAccess = {
  /** Allowed local roots for resolving outbound media paths; absent means no local root access. */
  localRoots?: readonly string[];
  /** Optional host reader; callers must also provide localRoots before it can be used. */
  readFile?: OutboundMediaReadFile;
  /** Agent workspace directory for resolving relative media paths. */
  workspaceDir?: string;
};

export type OutboundMediaLoadParams = {
  /** Maximum bytes accepted while loading or fetching one media source. */
  maxBytes?: number;
  /** Structured media access object preferred over legacy root/read fields. */
  mediaAccess?: OutboundMediaAccess;
  /** Legacy local root list or explicit "any" opt-in for host reads. */
  mediaLocalRoots?: readonly string[] | "any";
  /** Legacy host reader, used only when mediaAccess.readFile is absent. */
  mediaReadFile?: OutboundMediaReadFile;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative media paths. */
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
  /** True when a host readFile was accepted with matching local root policy. */
  hostReadCapability?: boolean;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative media paths. */
  workspaceDir?: string;
};

export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[] | "any",
): readonly string[] | "any" | undefined {
  if (mediaLocalRoots === "any") {
    return mediaLocalRoots;
  }
  return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}

/** Normalizes structured and legacy media access fields into one access object. */
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
  if (!localRoots && !readFile && !workspaceDir) {
    return undefined;
  }
  return {
    ...(localRoots ? { localRoots } : {}),
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
    // Host readers are only safe when paired with explicit roots, or the caller deliberately
    // passes localRoots: "any"; otherwise a reader would silently bypass path policy.
    if (!localRoots) {
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
    ...(localRoots ? { localRoots } : {}),
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
