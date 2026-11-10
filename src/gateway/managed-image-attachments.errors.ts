import type { ManagedMediaKind } from "./managed-image-attachments.media-kind.js";

export function createManagedImageAttachmentError(message: string) {
  const error = new Error(message);
  error.name = "ManagedImageAttachmentError";
  return error;
}

// Absolute paths in an error message can reveal the host filesystem layout; only preserve
// the underlying preparation reason as the sanitized error's cause when it is safe to log.
const PRIVATE_PATH_RE = /(?:[A-Za-z]:[\\/]|(?:^|[\s'"`(=:,])(?:~|[\\/]{1,2})(?![\\/]))/u;

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
  const sanitized = createManagedImageAttachmentError(
    `Managed ${kind} attachment ${JSON.stringify(label)} could not be prepared`,
  );
  if (error instanceof Error && !PRIVATE_PATH_RE.test(error.message)) {
    sanitized.cause = error;
  }
  return sanitized;
}
