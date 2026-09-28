// Hashes installed plugin index records for change detection.
import crypto from "node:crypto";
import fs from "node:fs";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { PluginDiagnostic } from "./manifest-types.js";

/** File metadata signature used to skip unchanged installed plugin files. */
export type InstalledPluginFileSignature = {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
};

function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Hashes JSON-serializable data with SHA-256. */
export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

/** Hashes JSON-like data independently of object property insertion order. */
export function hashStableJson(value: unknown): string {
  return hashString(stableStringify(value));
}

/** Safely hashes a file, optionally recording required-file diagnostics. */
export function safeHashFile(params: {
  filePath: string;
  pluginId?: string;
  diagnostics: PluginDiagnostic[];
  required: boolean;
}): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(params.filePath)).digest("hex");
  } catch (err) {
    if (params.required) {
      params.diagnostics.push({
        level: "warn",
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
        source: params.filePath,
        message: `installed plugin index could not hash ${params.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
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
