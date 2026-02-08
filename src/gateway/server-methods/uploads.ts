import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { saveUpload, cleanOldUploads } from "../uploads/store.js";

/**
 * Validate upload params
 */
function validateUploadParams(params: Record<string, unknown>):
  | {
      ok: true;
      fileName: string;
      content: string;
      mimeType?: string;
    }
  | { ok: false; error: string } {
  const { fileName, content, mimeType } = params;

  if (typeof fileName !== "string" || !fileName.trim()) {
    return { ok: false, error: "fileName is required" };
  }

  if (typeof content !== "string" || !content) {
    return { ok: false, error: "content (base64) is required" };
  }

  return {
    ok: true,
    fileName: fileName.trim(),
    content,
    mimeType: typeof mimeType === "string" ? mimeType : undefined,
  };
}

/**
 * Upload handlers for WebSocket methods
 */
export const uploadHandlers: GatewayRequestHandlers = {
  /**
   * Upload a file via WebSocket
   *
   * Params:
   *   - fileName: string (original filename)
   *   - content: string (base64 encoded file content)
   *   - mimeType?: string (optional mime type hint)
   *
   * Returns:
   *   - id: string (stored file ID)
   *   - path: string (absolute file path)
   *   - fileName: string (original filename)
   *   - size: number (file size in bytes)
   *   - mimeType?: string (detected mime type)
   */
  "uploads.upload": async ({ params, respond }) => {
    const validated = validateUploadParams(params);
    if (!validated.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, validated.error));
      return;
    }

    // Clean old uploads periodically (async, don't wait)
    void cleanOldUploads().catch(() => {});

    try {
      // Decode base64 content
      const buffer = Buffer.from(validated.content, "base64");

      if (buffer.length === 0) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Empty upload"));
        return;
      }

      const saved = await saveUpload(buffer, validated.fileName, validated.mimeType);

      respond(true, {
        id: saved.id,
        path: saved.path,
        fileName: saved.fileName,
        size: saved.size,
        mimeType: saved.mimeType,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
};
