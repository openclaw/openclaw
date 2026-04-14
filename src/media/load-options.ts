export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;

export type OutboundMediaAccess = {
  localRoots?: readonly string[] | "any";
  readFile?: OutboundMediaReadFile;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  readFile?: (filePath: string) => Promise<Buffer>;
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
  return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}

export function resolveOutboundMediaAccess(
  params: {
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: OutboundMediaReadFile;
  } = {},
): OutboundMediaAccess | undefined {
  const localRoots = resolveOutboundMediaLocalRoots(
    params.mediaAccess?.localRoots ?? params.mediaLocalRoots,
  );
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
  const mediaAccess = resolveOutboundMediaAccess(params);
  const workspaceDir = mediaAccess?.workspaceDir ?? params.workspaceDir;
  const localRoots = mediaAccess?.localRoots;
  if (mediaAccess?.readFile) {
    if (!localRoots) {
      throw new Error(
        'Host media read requires explicit localRoots. Pass mediaAccess.localRoots or opt in with localRoots: "any".',
      );
    }
    return {
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      localRoots,
      readFile: mediaAccess.readFile,
      hostReadCapability: true,
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots ? { localRoots } : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}
