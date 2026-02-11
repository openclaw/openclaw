/**
 * Storage backend factory.
 *
 * @module backup/storage/factory
 */
import path from "node:path";
import type { BackupStorageConfig, StorageBackend } from "../types.js";
import { resolveStateDir } from "../../config/paths.js";
import { createLocalStorage } from "./local.js";

const DEFAULT_LOCAL_DIR = "backups";

/**
 * Create a storage backend from config.
 *
 * Falls back to local storage at `<stateDir>/backups` when no config is provided.
 */
export async function createStorageBackend(config?: BackupStorageConfig): Promise<StorageBackend> {
  const type = config?.type ?? "local";

  if (type === "s3") {
    // Dynamic import to keep @aws-sdk/client-s3 optional
    const { createS3Storage } = await import("./s3.js");
    if (!config) {
      throw new Error("S3 storage requires backup.storage config");
    }
    return createS3Storage(config);
  }

  // Default: local storage
  const dir = config?.path ?? path.join(resolveStateDir(), DEFAULT_LOCAL_DIR);
  return createLocalStorage(dir);
}
