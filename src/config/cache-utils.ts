import fs from "node:fs";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

export function resolveCacheTtlMs(params: {
  envValue: string | undefined;
  defaultTtlMs: number;
}): number {
  const { envValue, defaultTtlMs } = params;
  if (envValue) {
    const parsed = parseStrictNonNegativeInteger(envValue);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return defaultTtlMs;
}

export function isCacheEnabled(ttlMs: number): boolean {
  return ttlMs > 0;
}

export type FileStatSnapshot = {
  mtimeMs: number;
  sizeBytes: number;
};

export function getFileStatSnapshot(filePath: string): FileStatSnapshot | undefined {
  try {
    const stats = fs.statSync(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  } catch {
    return undefined;
  }
}
