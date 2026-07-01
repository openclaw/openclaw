import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  type SnapshotArtifact,
  type SnapshotManifest,
} from "./snapshot-provider.js";

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function buildSnapshotArtifact(
  snapshotDir: string,
  artifactPath: string,
): Promise<SnapshotArtifact> {
  const stat = await fs.stat(artifactPath);
  const relativePath = path.relative(snapshotDir, artifactPath).split(path.sep).join("/");
  return {
    path: relativePath,
    sha256: await sha256File(artifactPath),
    sizeBytes: stat.size,
  };
}

export async function writeSnapshotManifest(
  snapshotDir: string,
  manifest: SnapshotManifest,
): Promise<void> {
  await fs.writeFile(
    path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

export async function readSnapshotManifest(snapshotDir: string): Promise<SnapshotManifest> {
  const manifestPath = path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME);
  const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  return normalizeSnapshotManifest(parsed, manifestPath);
}

function normalizeSnapshotManifest(value: unknown, manifestPath: string): SnapshotManifest {
  if (!value || typeof value !== "object") {
    throw new Error(`Snapshot manifest must be an object: ${manifestPath}`);
  }
  const record = value as Record<string, unknown>;
  const database = record.database;
  const artifact = record.artifact;
  if (record.schemaVersion !== 1) {
    throw new Error(`Unsupported snapshot manifest schemaVersion: ${String(record.schemaVersion)}`);
  }
  if (typeof record.snapshotId !== "string" || record.snapshotId.length === 0) {
    throw new Error(`Snapshot manifest missing snapshotId: ${manifestPath}`);
  }
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) {
    throw new Error(`Snapshot manifest missing createdAt: ${manifestPath}`);
  }
  if (!database || typeof database !== "object") {
    throw new Error(`Snapshot manifest missing database metadata: ${manifestPath}`);
  }
  if (!artifact || typeof artifact !== "object") {
    throw new Error(`Snapshot manifest missing artifact metadata: ${manifestPath}`);
  }
  const databaseRecord = database as Record<string, unknown>;
  const artifactRecord = artifact as Record<string, unknown>;
  return {
    schemaVersion: 1,
    snapshotId: record.snapshotId,
    createdAt: record.createdAt,
    database: {
      id: requireString(databaseRecord.id, "database.id", manifestPath),
      ...(typeof databaseRecord.kind === "string" ? { kind: databaseRecord.kind } : {}),
      basename: requireString(databaseRecord.basename, "database.basename", manifestPath),
      userVersion: requireInteger(databaseRecord.userVersion, "database.userVersion", manifestPath),
    },
    artifact: {
      path: requireSafeRelativePath(
        requireString(artifactRecord.path, "artifact.path", manifestPath),
        manifestPath,
      ),
      sha256: requireString(artifactRecord.sha256, "artifact.sha256", manifestPath),
      sizeBytes: requireNonNegativeInteger(
        artifactRecord.sizeBytes,
        "artifact.sizeBytes",
        manifestPath,
      ),
    },
  };
}

function requireString(value: unknown, field: string, manifestPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Snapshot manifest missing ${field}: ${manifestPath}`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string, manifestPath: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Snapshot manifest invalid ${field}: ${manifestPath}`);
  }
  return value as number;
}

function requireInteger(value: unknown, field: string, manifestPath: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Snapshot manifest invalid ${field}: ${manifestPath}`);
  }
  return value as number;
}

function requireSafeRelativePath(value: string, manifestPath: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`Snapshot manifest artifact path must be relative: ${manifestPath}`);
  }
  return normalized;
}
