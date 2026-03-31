export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;

export type OutboundMediaAccess = {
  localRoots?: readonly string[];
  readFile?: OutboundMediaReadFile;
};

export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
  optimizeImages?: boolean;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  readFile?: (filePath: string) => Promise<Buffer>;
  hostReadCapability?: boolean;
  optimizeImages?: boolean;
};

export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[],
): readonly string[] | undefined {
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
  if (!localRoots && !readFile) {
    return undefined;
  }
  return {
    ...(localRoots ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
  };
}

export function buildOutboundMediaLoadOptions(
  params: OutboundMediaLoadParams = {},
): OutboundMediaLoadOptions {
  const mediaAccess = resolveOutboundMediaAccess(params);
  if (mediaAccess?.readFile) {
    return {
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      localRoots: "any",
      readFile: mediaAccess.readFile,
      hostReadCapability: true,
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    };
  }
  const localRoots = mediaAccess?.localRoots;
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots ? { localRoots } : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
  };
}
