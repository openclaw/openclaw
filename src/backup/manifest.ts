/**
 * Backup manifest creation and validation.
 *
 * @module backup/manifest
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupComponent, BackupManifest, ManifestEntry } from "./types.js";

const MANIFEST_VERSION = 1 as const;

/**
 * Compute SHA-256 of a file.
 */
export async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Build a manifest from a staging directory that is ready to be archived.
 */
export async function buildManifest(opts: {
  stagingDir: string;
  components: BackupComponent[];
  openclawVersion: string;
  label?: string;
  encrypted?: boolean;
}): Promise<BackupManifest> {
  const entries = await collectEntries(opts.stagingDir, opts.stagingDir);

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    openclawVersion: opts.openclawVersion,
    components: opts.components,
    entries,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.encrypted ? { encrypted: true } : {}),
  };
}

/**
 * Recursively collect entries from a directory.
 */
async function collectEntries(baseDir: string, currentDir: string): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  const items = await fs.readdir(currentDir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(currentDir, item.name);
    if (item.isDirectory()) {
      const subEntries = await collectEntries(baseDir, fullPath);
      entries.push(...subEntries);
    } else if (item.isFile()) {
      const stat = await fs.stat(fullPath);
      const hash = await sha256File(fullPath);
      entries.push({
        path: path.relative(baseDir, fullPath),
        sha256: hash,
        size: stat.size,
      });
    }
  }

  return entries;
}

/**
 * Validate a manifest read from an archive.
 * Returns an array of error messages; empty means valid.
 */
export function validateManifest(manifest: unknown): string[] {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object") {
    return ["manifest is not an object"];
  }

  const m = manifest as Record<string, unknown>;

  if (m.version !== MANIFEST_VERSION) {
    errors.push(
      `unsupported manifest version: ${String(m.version)} (expected ${MANIFEST_VERSION})`,
    );
  }

  if (typeof m.createdAt !== "string") {
    errors.push("missing or invalid createdAt");
  }

  if (typeof m.openclawVersion !== "string") {
    errors.push("missing or invalid openclawVersion");
  }

  if (!Array.isArray(m.components) || m.components.length === 0) {
    errors.push("components must be a non-empty array");
  }

  if (!Array.isArray(m.entries)) {
    errors.push("entries must be an array");
  }

  return errors;
}

/**
 * Verify file integrity after extraction by checking SHA-256 checksums.
 * Returns a list of mismatched entries.
 */
export async function verifyIntegrity(
  manifest: BackupManifest,
  extractDir: string,
): Promise<ManifestEntry[]> {
  const mismatched: ManifestEntry[] = [];

  for (const entry of manifest.entries) {
    const filePath = path.join(extractDir, entry.path);
    try {
      const hash = await sha256File(filePath);
      if (hash !== entry.sha256) {
        mismatched.push(entry);
      }
    } catch {
      mismatched.push(entry);
    }
  }

  return mismatched;
}
