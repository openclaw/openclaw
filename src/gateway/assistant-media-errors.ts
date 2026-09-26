import { FsSafeError } from "../infra/fs-safe.js";
import type { MediaProbeResult } from "../media/media-probe.js";
import { PlaybackInspectionBusyError } from "../media/playback-transcode.js";

export type AssistantMediaAvailability =
  | ({
      available: true;
      mimeType?: string;
      playback?: "native" | "transcode";
      sizeBytes?: number;
    } & MediaProbeResult)
  | { available: false; reason: string; code: string; retryable?: boolean };

export function classifyAssistantMediaError(err: unknown): AssistantMediaAvailability {
  if (err instanceof PlaybackInspectionBusyError) {
    return {
      available: false,
      code: "attachment-unavailable",
      reason: err.message,
      retryable: true,
    };
  }
  if (err instanceof FsSafeError) {
    switch (err.code) {
      case "not-found":
        return { available: false, code: "file-not-found", reason: "File not found" };
      case "not-file":
        return { available: false, code: "not-a-file", reason: "Not a file" };
      case "invalid-path":
      case "path-mismatch":
      case "symlink":
        return { available: false, code: "invalid-file", reason: "Invalid file" };
      default:
        return {
          available: false,
          code: "attachment-unavailable",
          reason: "Attachment unavailable",
        };
    }
  }
  if (err instanceof Error && "code" in err) {
    const errorCode = err.code;
    switch (typeof errorCode === "string" ? errorCode : "") {
      case "unsupported-media-type":
        return { available: false, code: "unsupported-media-type", reason: "Not an image" };
      case "path-not-allowed":
        return {
          available: false,
          code: "outside-allowed-folders",
          reason: "Outside allowed folders",
        };
      case "invalid-file-url":
      case "invalid-path":
      case "unsafe-bypass":
      case "network-path-not-allowed":
      case "invalid-root":
        return { available: false, code: "blocked-local-file", reason: "Blocked local file" };
      case "not-found":
        return { available: false, code: "file-not-found", reason: "File not found" };
      case "not-file":
        return { available: false, code: "not-a-file", reason: "Not a file" };
      default:
        break;
    }
  }
  return { available: false, code: "attachment-unavailable", reason: "Attachment unavailable" };
}
