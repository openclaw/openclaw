import { FileUploadManager, type FileChunkParams } from "../file-upload.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateFileChunkParams,
  validateFileCompleteParams,
  validateFileCancelParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Per-connection file upload managers, keyed by connId.
 * This allows each WebSocket connection to have its own upload state.
 */
const uploadManagers = new Map<string, FileUploadManager>();

function getOrCreateManager(
  connId: string,
  logGateway?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  },
): FileUploadManager {
  let manager = uploadManagers.get(connId);
  if (!manager) {
    manager = new FileUploadManager({ log: logGateway });
    uploadManagers.set(connId, manager);
  }
  return manager;
}

/**
 * Clean up the upload manager for a connection (call on disconnect).
 */
export function cleanupFileUploadManager(connId: string): void {
  const manager = uploadManagers.get(connId);
  if (manager) {
    manager.cleanup();
    uploadManagers.delete(connId);
  }
}

export const fileUploadHandlers: GatewayRequestHandlers = {
  "file.chunk": async ({ params, respond, context, client }) => {
    if (!validateFileChunkParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid file.chunk params: ${formatValidationErrors(validateFileChunkParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as FileChunkParams;
    const connId = client?.connId ?? "unknown";
    const manager = getOrCreateManager(connId, context.logGateway);
    const result = manager.handleChunk(p);

    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, result.error ?? "chunk handling failed"),
      );
      return;
    }

    respond(true, {
      uploadId: p.uploadId,
      chunkIndex: p.chunkIndex,
      chunksReceived: result.chunksReceived,
      totalChunks: p.totalChunks,
    });
  },

  "file.complete": async ({ params, respond, context, client }) => {
    if (!validateFileCompleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid file.complete params: ${formatValidationErrors(validateFileCompleteParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      uploadId: string;
      filename: string;
      mimeType: string;
      totalSize: number;
      sessionKey?: string;
    };
    const connId = client?.connId ?? "unknown";
    const manager = getOrCreateManager(connId, context.logGateway);

    try {
      const result = await manager.handleComplete(p);
      const notification = FileUploadManager.buildAgentNotification(result);

      // Broadcast file upload event to connected clients
      context.broadcast("file.uploaded", {
        uploadId: result.uploadId,
        filePath: result.filePath,
        filename: result.filename,
        mimeType: result.mimeType,
        totalSize: result.totalSize,
        ts: Date.now(),
      });

      // If a session key was provided, send the notification to that session
      if (p.sessionKey) {
        context.nodeSendToSession(p.sessionKey, "file.uploaded", {
          uploadId: result.uploadId,
          filePath: result.filePath,
          filename: result.filename,
          mimeType: result.mimeType,
          totalSize: result.totalSize,
          notification,
          ts: Date.now(),
        });
      }

      respond(true, {
        uploadId: result.uploadId,
        filePath: result.filePath,
        filename: result.filename,
        mimeType: result.mimeType,
        totalSize: result.totalSize,
        notification,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "file.cancel": async ({ params, respond, client }) => {
    if (!validateFileCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid file.cancel params: ${formatValidationErrors(validateFileCancelParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { uploadId: string };
    const connId = client?.connId ?? "unknown";
    const manager = uploadManagers.get(connId);
    const cancelled = manager?.cancel(p.uploadId) ?? false;

    respond(true, { uploadId: p.uploadId, cancelled });
  },
};
