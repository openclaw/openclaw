import { describe, expect, it } from "vitest";
import {
  createManagedImageAttachmentError,
  getSanitizedManagedImageAttachmentError,
} from "./managed-image-attachments.errors.js";

describe("getSanitizedManagedImageAttachmentError", () => {
  it("keeps managed errors unchanged with their actionable message", () => {
    const error = createManagedImageAttachmentError(
      'Managed image attachment "photo.png" is missing readable dimensions',
    );
    expect(getSanitizedManagedImageAttachmentError(error, "photo.png", "image")).toBe(error);
    const invalidData = new Error("Invalid image data URL");
    expect(getSanitizedManagedImageAttachmentError(invalidData, "audio", "audio")).toBe(
      invalidData,
    );
  });

  it("preserves the underlying reason when the message contains no private path", () => {
    const error = new Error("Local audio/video media requires an explicitly trusted reply payload");
    const sanitized = getSanitizedManagedImageAttachmentError(error, "voice.ogg", "audio");
    expect(sanitized.message).toBe('Managed audio attachment "voice.ogg" could not be prepared');
    expect(sanitized.cause).toBe(error);
  });

  it("keeps the generic reason for errors that could reveal a filesystem path", () => {
    const error = new Error(
      "Local media path is not under an allowed directory: C:\\Users\\me\\workspace\\voice.ogg",
    );
    const sanitized = getSanitizedManagedImageAttachmentError(error, "voice.ogg", "audio");
    expect(sanitized.message).toBe('Managed audio attachment "voice.ogg" could not be prepared');
    expect(sanitized.cause).toBeUndefined();
  });
});
