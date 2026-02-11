/**
 * Local filesystem storage backend for backups.
 *
 * @module backup/storage/local
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupEntry, BackupManifest, StorageBackend } from "../types.js";

/**
 * Create a local-filesystem storage backend.
 *
 * Archives are stored as `<dir>/<key>` where `key` is typically
 * `backup-<iso-timestamp>.tar.gz`.
 */
export function createLocalStorage(dir: string): StorageBackend {
  return {
    async put(key: string, data: Buffer | Uint8Array): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, key);
      await fs.writeFile(dest, data);
    },

    async get(key: string): Promise<Buffer> {
      return fs.readFile(path.join(dir, key));
    },

    async list(): Promise<BackupEntry[]> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return [];
      }

      const backups: BackupEntry[] = [];
      for (const name of entries
        .filter((n) => n.endsWith(".tar.gz"))
        .sort()
        .reverse()) {
        const filePath = path.join(dir, name);
        try {
          const stat = await fs.stat(filePath);
          // Try to read manifest from the archive for metadata.
          // Fall back to filename-derived metadata if the archive can't be inspected.
          const entry: BackupEntry = {
            id: name,
            createdAt: stat.mtime.toISOString(),
            size: stat.size,
            components: [],
          };

          // Best-effort: read companion manifest sidecar `<name>.manifest.json`
          const sidecarPath = `${filePath}.manifest.json`;
          try {
            const raw = await fs.readFile(sidecarPath, "utf-8");
            const manifest: BackupManifest = JSON.parse(raw);
            entry.createdAt = manifest.createdAt;
            entry.components = manifest.components;
            entry.label = manifest.label;
            entry.encrypted = manifest.encrypted;
          } catch {
            // sidecar missing – that's fine
          }

          backups.push(entry);
        } catch {
          // skip unreadable files
        }
      }

      return backups;
    },

    async delete(key: string): Promise<void> {
      const filePath = path.join(dir, key);
      await fs.unlink(filePath).catch(() => undefined);
      // Also remove sidecar manifest if present
      await fs.unlink(`${filePath}.manifest.json`).catch(() => undefined);
    },

    async exists(key: string): Promise<boolean> {
      try {
        await fs.access(path.join(dir, key));
        return true;
      } catch {
        return false;
      }
    },
  };
}
