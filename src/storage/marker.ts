import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { StorageBackend } from "./types.js";

export const STORAGE_MARKER_KEY = "openclaw-storage.json";
const KEY_CHECK = "openclaw-storage key check v1";
const base64 = (bytes: number) =>
  z.string().refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === bytes && decoded.toString("base64") === value;
  });
const markerSchema = z
  .object({
    version: z.literal(1),
    locationId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    encryption: z.union([
      z.literal("none"),
      z
        .object({
          kdf: z.literal("scrypt"),
          salt: base64(16),
          N: z.literal(32768),
          r: z.literal(8),
          p: z.literal(1),
          keyCheck: base64(32),
        })
        .strict(),
    ]),
  })
  .strict();
export type StorageMarker = z.infer<typeof markerSchema>;
export type StorageState = "ok" | "unavailable" | "uninitialized" | "wrong-key" | "error";

export class StorageLocationError extends Error {
  readonly state: Exclude<StorageState, "ok">;
  constructor(state: Exclude<StorageState, "ok">, message: string) {
    super(message);
    this.name = "StorageLocationError";
    this.state = state;
  }
}

const cacheFingerprintKey = randomBytes(32);
const masterKeys = new Map<string, { fingerprint: string; key: Promise<Buffer> }>();

function deriveMasterKey(locationName: string, passphrase: string, salt: string): Promise<Buffer> {
  const fingerprint = createHmac("sha256", cacheFingerprintKey)
    .update(salt)
    .update("\0")
    .update(passphrase)
    .digest("hex");
  const cached = masterKeys.get(locationName);
  if (cached?.fingerprint === fingerprint) {
    return cached.key;
  }
  const key = new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      Buffer.from(salt, "base64"),
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) {
          reject(error);
        } else {
          resolve(derived);
        }
      },
    );
  });
  masterKeys.set(locationName, { fingerprint, key });
  void key.catch(() => {
    if (masterKeys.get(locationName)?.key === key) {
      masterKeys.delete(locationName);
    }
  });
  return key;
}

export async function readStorageMarker(
  backend: StorageBackend,
  signal?: AbortSignal,
): Promise<StorageMarker | undefined> {
  const body = await backend.getObject(STORAGE_MARKER_KEY, { signal });
  if (!body) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > 4096) {
      throw new StorageLocationError("error", "Storage marker exceeds 4096 bytes.");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return markerSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new StorageLocationError("error", "Invalid storage location marker.");
  }
}

export async function verifyStorageMarker(
  name: string,
  marker: StorageMarker,
  passphrase: string | undefined,
): Promise<Buffer | undefined> {
  if (marker.encryption === "none") {
    if (passphrase !== undefined) {
      throw new StorageLocationError(
        "wrong-key",
        `Storage location "${name}" was initialized without encryption; restore its original encryption configuration.`,
      );
    }
    return undefined;
  }
  if (passphrase === undefined) {
    throw new StorageLocationError(
      "wrong-key",
      `Storage location "${name}" requires its original encryption passphrase.`,
    );
  }
  const masterKey = await deriveMasterKey(name, passphrase, marker.encryption.salt);
  const expected = Buffer.from(marker.encryption.keyCheck, "base64");
  const actual = createHmac("sha256", masterKey).update(KEY_CHECK).digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new StorageLocationError(
      "wrong-key",
      `Wrong encryption passphrase for storage location "${name}".`,
    );
  }
  return masterKey;
}

export async function createStorageMarker(
  name: string,
  passphrase: string | undefined,
): Promise<StorageMarker> {
  const marker: StorageMarker = {
    version: 1,
    locationId: randomUUID(),
    createdAt: Date.now(),
    encryption: "none",
  };
  if (passphrase !== undefined) {
    const salt = randomBytes(16).toString("base64");
    const key = await deriveMasterKey(name, passphrase, salt);
    marker.encryption = {
      kdf: "scrypt",
      salt,
      N: 32768,
      r: 8,
      p: 1,
      keyCheck: createHmac("sha256", key).update(KEY_CHECK).digest("base64"),
    };
  }
  return marker;
}
