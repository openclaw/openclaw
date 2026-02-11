/**
 * S3-compatible storage backend for backups.
 *
 * Supports AWS S3, Cloudflare R2, MinIO, and any S3-compatible service.
 * Uses dynamic import so `@aws-sdk/client-s3` is optional.
 *
 * @module backup/storage/s3
 */

import type { BackupEntry, BackupManifest, BackupStorageConfig, StorageBackend } from "../types.js";

type S3Client = import("@aws-sdk/client-s3").S3Client;

/** Lazy-load the AWS SDK to keep it optional. */
async function loadS3SDK() {
  try {
    return await import("@aws-sdk/client-s3");
  } catch {
    throw new Error(
      "S3 storage requires @aws-sdk/client-s3. Install it with: pnpm add @aws-sdk/client-s3",
    );
  }
}

export async function createS3Storage(config: BackupStorageConfig): Promise<StorageBackend> {
  const sdk = await loadS3SDK();

  const bucket = config.path;
  if (!bucket) {
    throw new Error("S3 storage requires backup.storage.path (bucket name)");
  }
  const prefix = config.prefix ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import type
  const clientOptions: Record<string, any> = {};
  if (config.region) {
    clientOptions.region = config.region;
  }
  if (config.endpoint) {
    clientOptions.endpoint = config.endpoint;
    clientOptions.forcePathStyle = true;
  }
  if (config.accessKeyId && config.secretAccessKey) {
    clientOptions.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }

  const client: S3Client = new sdk.S3Client(clientOptions);

  function fullKey(key: string): string {
    return prefix ? `${prefix}${key}` : key;
  }

  return {
    async put(key: string, data: Buffer | Uint8Array): Promise<void> {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          Body: data,
        }),
      );
    },

    async get(key: string): Promise<Buffer> {
      const response = await client.send(
        new sdk.GetObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
        }),
      );
      if (!response.Body) {
        throw new Error(`S3 object ${fullKey(key)} has no body`);
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    async list(): Promise<BackupEntry[]> {
      const response = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
        }),
      );

      const backups: BackupEntry[] = [];
      for (const obj of response.Contents ?? []) {
        const key = obj.Key;
        if (!key?.endsWith(".tar.gz")) {
          continue;
        }
        const id = prefix ? key.slice(prefix.length) : key;

        const entry: BackupEntry = {
          id,
          createdAt: obj.LastModified?.toISOString() ?? "",
          size: obj.Size ?? 0,
          components: [],
        };

        // Best-effort: read sidecar manifest
        try {
          const manifestKey = `${key}.manifest.json`;
          const manifestResponse = await client.send(
            new sdk.GetObjectCommand({ Bucket: bucket, Key: manifestKey }),
          );
          if (manifestResponse.Body) {
            const chunks: Uint8Array[] = [];
            for await (const chunk of manifestResponse.Body as AsyncIterable<Uint8Array>) {
              chunks.push(chunk);
            }
            const manifest: BackupManifest = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            entry.createdAt = manifest.createdAt;
            entry.components = manifest.components;
            entry.label = manifest.label;
            entry.encrypted = manifest.encrypted;
          }
        } catch {
          // sidecar missing – that's fine
        }

        backups.push(entry);
      }

      return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async delete(key: string): Promise<void> {
      const k = fullKey(key);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: k }));
      // Also remove sidecar
      await client
        .send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: `${k}.manifest.json` }))
        .catch(() => undefined);
    },

    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
