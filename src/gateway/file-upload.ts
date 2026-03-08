import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Chunked file upload handler for large files over WebSocket.
 *
 * Protocol:
 * 1. Client sends chunks:  { type: "file.chunk", uploadId, chunkIndex, totalChunks, data: base64 }
 * 2. Client sends complete: { type: "file.complete", uploadId, filename, mimeType, totalSize }
 * 3. Server assembles file and writes to uploads directory.
 * 4. Server responds with file path and metadata.
 */

/** Default uploads directory under the OpenClaw workspace. */
const DEFAULT_UPLOADS_DIR = path.join(os.homedir(), ".openclaw", "workspace", "uploads");

/** Maximum allowed file size (10 GB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

/** Maximum chunk size in decoded bytes (~8 MB base64 → ~6 MB decoded). */
const MAX_CHUNK_SIZE = 8 * 1024 * 1024;

/** Maximum time an upload can be in-progress before cleanup (30 minutes). */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** Maximum concurrent uploads per connection. */
const MAX_CONCURRENT_UPLOADS = 10;

export type FileChunkParams = {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // base64
};

export type FileCompleteParams = {
  uploadId: string;
  filename: string;
  mimeType: string;
  totalSize: number;
};

export type FileUploadResult = {
  uploadId: string;
  filePath: string;
  filename: string;
  mimeType: string;
  totalSize: number;
};

type UploadState = {
  uploadId: string;
  receivedChunks: Map<number, Buffer>;
  totalChunks: number;
  totalBytesReceived: number;
  createdAt: number;
};

type FileUploadLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

function sanitizeFilename(filename: string): string {
  // Remove path traversal attempts and dangerous characters
  const base = path.basename(filename);
  // Replace anything that's not alphanumeric, dot, dash, underscore, or space
  const sanitized = base.replace(/[^\w.\- ]/g, "_");
  // Prevent hidden files
  const noHidden = sanitized.replace(/^\.+/, "");
  return noHidden || "unnamed-file";
}

function ensureUniqueFilename(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${counter}${ext}`;
    counter++;
  }
  return candidate;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function validateFileChunkParams(params: unknown): params is FileChunkParams {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  return (
    typeof p.uploadId === "string" &&
    p.uploadId.length > 0 &&
    typeof p.chunkIndex === "number" &&
    Number.isInteger(p.chunkIndex) &&
    p.chunkIndex >= 0 &&
    typeof p.totalChunks === "number" &&
    Number.isInteger(p.totalChunks) &&
    p.totalChunks > 0 &&
    typeof p.data === "string" &&
    p.data.length > 0
  );
}

export function validateFileCompleteParams(params: unknown): params is FileCompleteParams {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  return (
    typeof p.uploadId === "string" &&
    p.uploadId.length > 0 &&
    typeof p.filename === "string" &&
    p.filename.length > 0 &&
    typeof p.mimeType === "string" &&
    p.mimeType.length > 0 &&
    typeof p.totalSize === "number" &&
    p.totalSize > 0
  );
}

/**
 * Manages chunked file uploads for a single WebSocket connection.
 * Each connection should have its own FileUploadManager instance.
 */
export class FileUploadManager {
  private uploads = new Map<string, UploadState>();
  private uploadsDir: string;
  private log: FileUploadLog;

  constructor(opts?: { uploadsDir?: string; log?: FileUploadLog }) {
    this.uploadsDir = opts?.uploadsDir ?? DEFAULT_UPLOADS_DIR;
    this.log = opts?.log ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  /** Clean up timed-out uploads. */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, state] of this.uploads) {
      if (now - state.createdAt > UPLOAD_TIMEOUT_MS) {
        this.uploads.delete(id);
        this.log.warn(`upload ${id} expired after ${UPLOAD_TIMEOUT_MS / 1000}s, cleaned up`);
      }
    }
  }

  /**
   * Handle a file chunk. Returns an ack or error.
   */
  handleChunk(params: FileChunkParams): { ok: boolean; error?: string; chunksReceived?: number } {
    this.pruneExpired();

    const { uploadId, chunkIndex, totalChunks, data } = params;

    // Validate chunk index
    if (chunkIndex >= totalChunks) {
      return { ok: false, error: `chunk index ${chunkIndex} >= totalChunks ${totalChunks}` };
    }

    // Check concurrent upload limit
    if (!this.uploads.has(uploadId) && this.uploads.size >= MAX_CONCURRENT_UPLOADS) {
      return {
        ok: false,
        error: `too many concurrent uploads (max ${MAX_CONCURRENT_UPLOADS})`,
      };
    }

    // Decode chunk
    let chunkBuffer: Buffer;
    try {
      chunkBuffer = Buffer.from(data, "base64");
    } catch {
      return { ok: false, error: "invalid base64 data in chunk" };
    }

    if (chunkBuffer.length > MAX_CHUNK_SIZE) {
      return {
        ok: false,
        error: `chunk too large (${chunkBuffer.length} > ${MAX_CHUNK_SIZE} bytes)`,
      };
    }

    // Get or create upload state
    let state = this.uploads.get(uploadId);
    if (!state) {
      state = {
        uploadId,
        receivedChunks: new Map(),
        totalChunks,
        totalBytesReceived: 0,
        createdAt: Date.now(),
      };
      this.uploads.set(uploadId, state);
    }

    // Validate totalChunks consistency
    if (state.totalChunks !== totalChunks) {
      return {
        ok: false,
        error: `totalChunks mismatch: expected ${state.totalChunks}, got ${totalChunks}`,
      };
    }

    // Check for duplicate chunk
    if (state.receivedChunks.has(chunkIndex)) {
      return { ok: true, chunksReceived: state.receivedChunks.size };
    }

    // Check total size limit
    state.totalBytesReceived += chunkBuffer.length;
    if (state.totalBytesReceived > MAX_FILE_SIZE) {
      this.uploads.delete(uploadId);
      return { ok: false, error: `file exceeds maximum size of ${formatFileSize(MAX_FILE_SIZE)}` };
    }

    state.receivedChunks.set(chunkIndex, chunkBuffer);

    return { ok: true, chunksReceived: state.receivedChunks.size };
  }

  /**
   * Complete an upload: assemble chunks, write file, clean up state.
   */
  async handleComplete(params: FileCompleteParams): Promise<FileUploadResult> {
    const { uploadId, filename, mimeType, totalSize } = params;

    const state = this.uploads.get(uploadId);
    if (!state) {
      throw new Error(`no active upload with id ${uploadId}`);
    }

    // Check all chunks received
    if (state.receivedChunks.size !== state.totalChunks) {
      throw new Error(
        `incomplete upload: received ${state.receivedChunks.size}/${state.totalChunks} chunks`,
      );
    }

    // Assemble chunks in order
    const orderedChunks: Buffer[] = [];
    for (let i = 0; i < state.totalChunks; i++) {
      const chunk = state.receivedChunks.get(i);
      if (!chunk) {
        this.uploads.delete(uploadId);
        throw new Error(`missing chunk ${i}`);
      }
      orderedChunks.push(chunk);
    }

    const assembled = Buffer.concat(orderedChunks);

    // Validate total size (allow some tolerance for base64 overhead estimation)
    if (totalSize > 0 && Math.abs(assembled.length - totalSize) > totalSize * 0.01 + 1024) {
      this.uploads.delete(uploadId);
      throw new Error(
        `size mismatch: assembled ${assembled.length} bytes, expected ~${totalSize} bytes`,
      );
    }

    // Ensure uploads directory exists
    await fs.promises.mkdir(this.uploadsDir, { recursive: true });

    // Sanitize and deduplicate filename
    const safeName = sanitizeFilename(filename);
    // Add a short random suffix to prevent collisions
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    const uniqueSuffix = crypto.randomBytes(4).toString("hex");
    const uniqueName = ensureUniqueFilename(this.uploadsDir, `${base}-${uniqueSuffix}${ext}`);
    const filePath = path.join(this.uploadsDir, uniqueName);

    // Write the file
    await fs.promises.writeFile(filePath, assembled);

    // Clean up upload state
    this.uploads.delete(uploadId);

    this.log.info(
      `file upload complete: ${uniqueName} (${formatFileSize(assembled.length)}, ${mimeType})`,
    );

    return {
      uploadId,
      filePath,
      filename: uniqueName,
      mimeType,
      totalSize: assembled.length,
    };
  }

  /**
   * Cancel an in-progress upload.
   */
  cancel(uploadId: string): boolean {
    return this.uploads.delete(uploadId);
  }

  /**
   * Clean up all uploads (e.g. on connection close).
   */
  cleanup(): void {
    this.uploads.clear();
  }

  /**
   * Build the notification message for the agent when a file upload completes.
   */
  static buildAgentNotification(result: FileUploadResult): string {
    return (
      `📎 File received: \`${result.filePath}\` ` +
      `(type: ${result.mimeType}, size: ${formatFileSize(result.totalSize)}) — ready for processing`
    );
  }
}
