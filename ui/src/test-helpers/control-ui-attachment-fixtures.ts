// Serialized into the mock Gateway's page realm; keep this builder free of module captures.
export function createControlUiAttachmentFacts(attachments: unknown) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    )
    .map((attachment) => {
      const fact = {
        kind:
          typeof attachment.mimeType === "string" && attachment.mimeType.startsWith("image/")
            ? "image"
            : "file",
        contentType: attachment.mimeType,
        fileName: attachment.fileName,
        url: `data:${typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream"};base64,${typeof attachment.content === "string" ? attachment.content : ""}`,
      };
      return attachment.origin === "paste" || attachment.origin === "file"
        ? Object.assign(fact, { origin: attachment.origin })
        : fact;
    });
}
