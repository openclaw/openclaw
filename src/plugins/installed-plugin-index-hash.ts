// Hashes installed plugin index records for change detection.
import fs from "node:fs";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";

/** File metadata signature used to skip unchanged installed plugin files. */
export type InstalledPluginFileSignature = {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
};

/** Hashes JSON-serializable data with SHA-256. */
export function hashJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

/** Hashes JSON-like data independently of object property insertion order. */
export function hashStableJson(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function safeHashFile(filePath: string): string | undefined {
  try {
    return sha256Hex(fs.readFileSync(filePath));
  } catch {
    return undefined;
  }
}

/** Reads a safe file signature for installed plugin index freshness checks. */
export function safeFileSignature(filePath: string): InstalledPluginFileSignature | undefined {
  const stat = safeStatSync(filePath);
  return stat?.isFile()
    ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    : undefined;
}
