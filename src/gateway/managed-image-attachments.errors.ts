import type { ManagedMediaKind } from "./managed-image-attachments.media-kind.js";

export function createManagedImageAttachmentError(message: string) {
  const error = new Error(message);
  error.name = "ManagedImageAttachmentError";
  return error;
}

// The sanitized error keeps an actionable, path-free message for strict callers and display.
// The original preparation error is always preserved as its cause so the logging owner can
// surface the underlying reason (including path-bearing refusals); logs are written raw and
// redacted at egress.
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
  if (error instanceof Error) {
    sanitized.cause = error;
  }
  return sanitized;
}
