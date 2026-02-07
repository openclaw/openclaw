import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ArtifactMime = "text/plain" | "text/markdown" | "application/json" | (string & {});

export type ArtifactMeta = {
  id: string;
  mime: ArtifactMime;
  createdAt: string;
  sha256: string;
  sizeBytes: number;
};

export class ArtifactTooLargeError extends Error {
  public readonly sizeBytes: number;
  public readonly maxBytes: number;

  constructor(message: string, params: { sizeBytes: number; maxBytes: number }) {
    super(message);
    this.name = "ArtifactTooLargeError";
    this.sizeBytes = params.sizeBytes;
    this.maxBytes = params.maxBytes;
  }
}

export type ArtifactRegistry = {
  storeText: (params: {
    content: string;
    mime?: ArtifactMime;
    maxBytes?: number;
  }) => Promise<ArtifactMeta>;
  storeJson: (params: { value: unknown; maxBytes?: number }) => Promise<ArtifactMeta>;
  get: (id: string) => Promise<{ meta: ArtifactMeta; content: string }>;
};

const DEFAULT_MAX_BYTES = 512 * 1024; // 512KB

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function resolveShardDir(rootDir: string, sha256: string): string {
  const shard = sha256.slice(0, 2);
  return path.join(rootDir, shard, sha256);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createArtifactRegistry(params: { rootDir: string }): ArtifactRegistry {
  const rootDir = params.rootDir;

  const store = async (params: {
    content: string;
    mime: ArtifactMime;
    maxBytes?: number;
  }): Promise<ArtifactMeta> => {
    const maxBytes = Math.floor(params.maxBytes ?? DEFAULT_MAX_BYTES);
    const buf = Buffer.from(params.content, "utf-8");
    if (buf.byteLength > maxBytes) {
      throw new ArtifactTooLargeError(
        `Artifact too large (${buf.byteLength} bytes; max ${maxBytes}).`,
        { sizeBytes: buf.byteLength, maxBytes },
      );
    }

    const sha256 = sha256Hex(buf);
    const id = sha256;
    const createdAt = new Date().toISOString();

    const dir = resolveShardDir(rootDir, sha256);
    const metaPath = path.join(dir, "meta.json");
    const contentPath = path.join(dir, "content.txt");

    await fs.mkdir(dir, { recursive: true });

    if (await fileExists(metaPath)) {
      const existing = JSON.parse(await fs.readFile(metaPath, "utf-8")) as ArtifactMeta;
      return existing;
    }

    const meta: ArtifactMeta = {
      id,
      mime: params.mime,
      createdAt,
      sha256,
      sizeBytes: buf.byteLength,
    };

    await fs.writeFile(contentPath, params.content, "utf-8");
    await fs.writeFile(metaPath, JSON.stringify(meta), "utf-8");
    return meta;
  };

  const get: ArtifactRegistry["get"] = async (id) => {
    const sha256 = id;
    const dir = resolveShardDir(rootDir, sha256);
    const metaPath = path.join(dir, "meta.json");
    const contentPath = path.join(dir, "content.txt");

    const metaRaw = await fs.readFile(metaPath, "utf-8");
    const meta = JSON.parse(metaRaw) as ArtifactMeta;
    const content = await fs.readFile(contentPath, "utf-8");
    return { meta, content };
  };

  return {
    storeText: async (params) =>
      store({
        content: params.content,
        mime: params.mime ?? "text/plain",
        maxBytes: params.maxBytes,
      }),
    storeJson: async (params) =>
      store({
        content: JSON.stringify(params.value, null, 2) ?? "null",
        mime: "application/json",
        maxBytes: params.maxBytes,
      }),
    get,
  };
}
