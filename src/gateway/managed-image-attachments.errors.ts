import type { ManagedMediaKind } from "./managed-image-attachments.media-kind.js";

export function createManagedImageAttachmentError(message: string) {
  const error = new Error(message);
  error.name = "ManagedImageAttachmentError";
  return error;
}

export function getSanitizedManagedImageAttachmentError(
  error: unknown,
  label: string,
  kind: ManagedMediaKind | "media",
): Error {
  if (
    error instanceof Error &&
    (error.name === "ManagedImageAttachmentError" ||
      error.message.startsWith("Managed image attachment ") ||
      error.message.startsWith("Invalid image data URL"))
  ) {
    return error;
  }
  return createManagedImageAttachmentError(
    `Managed ${kind} attachment ${JSON.stringify(label)} could not be prepared`,
  );
}
