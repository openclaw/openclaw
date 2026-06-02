export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";

/** Legacy agent media fields consumed by channel/plugin bridges. */
export type AgentMediaPayload = {
  /** First local path, mirrored for older single-media callers. */
  MediaPath?: string;
  /** First media content type when the source provided one. */
  MediaType?: string;
  /** First media URL/path, retained for agents that only read URL-style fields. */
  MediaUrl?: string;
  /** All local media paths in outbound order. */
  MediaPaths?: string[];
  /** All media URL/path values in outbound order. */
  MediaUrls?: string[];
  /** Content types for entries that provided one; indexes may not match MediaPaths. */
  MediaTypes?: string[];
};

/** Convert outbound media descriptors into the legacy agent payload field layout. */
export function buildAgentMediaPayload(
  mediaList: Array<{ path: string; contentType?: string | null }>,
): AgentMediaPayload {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType ?? undefined,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
