export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
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

export function buildOutboundMediaLoadOptions(
  params: OutboundMediaLoadParams = {},
): OutboundMediaLoadOptions {
  if (params.mediaReadFile) {
    return {
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      localRoots: "any",
      readFile: params.mediaReadFile,
      hostReadCapability: true,
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    };
  }
  const localRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots ? { localRoots } : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
  };
}
