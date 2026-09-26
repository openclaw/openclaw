export const MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX = "artifact_managed_image_";
export const MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX = "artifact_managed_media_";
export const MANAGED_OUTGOING_ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseManagedOutgoingArtifactId(
  value: string,
): { attachmentId: string; family: "image" | "media" } | null {
  const family = value.startsWith(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX)
    ? "image"
    : value.startsWith(MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX)
      ? "media"
      : null;
  if (!family) {
    return null;
  }
  const prefix =
    family === "image"
      ? MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX
      : MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX;
  const attachmentId = value.slice(prefix.length);
  return MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId) ? { attachmentId, family } : null;
}
