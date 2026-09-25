import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../infra/crypto-digest.js";
import { hasErrnoCode } from "../infra/errno.js";
import { ensureAbsoluteDirectory } from "../infra/fs-safe.js";
import { isCaseSensitiveDirectory, TRANSCRIPT_EXPORT_FILE_NAMES } from "./store-artifacts.js";
import {
  parseTranscriptExportManifest,
  parseTranscriptPendingExports,
} from "./store-export-state.js";
import type {
  readTranscriptExportPathCollisions,
  readTranscriptExportPathOwners,
} from "./store-sqlite-read.js";
import type { MeetingTranscriptSessionRow } from "./store-sqlite.js";

type ExportOwnershipParams = {
  selector: string;
  exportRootDir: string;
};

async function transcriptArtifactsMatchOwner(
  sessionDir: string,
  artifacts: Array<{ entry: { name: string }; canonicalName: string }>,
  owner: Pick<MeetingTranscriptSessionRow, "export_manifest_json" | "export_pending_json">,
): Promise<boolean> {
  const manifest = parseTranscriptExportManifest(owner.export_manifest_json);
  const pending = parseTranscriptPendingExports(owner.export_pending_json);
  // Pending, altered, or symlinked artifacts must never establish aliased ownership.
  for (const { entry, canonicalName } of artifacts) {
    const artifactPath = path.join(sessionDir, entry.name);
    const stat = await fs.lstat(artifactPath);
    const expectedHash = manifest[canonicalName];
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      pending.has(canonicalName) ||
      !expectedHash ||
      (await sha256File(artifactPath)) !== expectedHash
    ) {
      return false;
    }
  }
  return artifacts.length > 0;
}

export async function assertTranscriptExportPathAvailable(
  params: ExportOwnershipParams & {
    collisions: ReturnType<typeof readTranscriptExportPathCollisions>;
  },
): Promise<void> {
  const { collisions } = params;
  if (collisions.length <= 1) {
    return;
  }
  const ensured = await ensureAbsoluteDirectory(params.exportRootDir, {
    mode: 0o700,
    scopeLabel: "transcript export root",
  });
  if (!ensured.ok) {
    throw ensured.error;
  }
  if (await isCaseSensitiveDirectory(params.exportRootDir)) {
    return;
  }
  let ownerSelector: string | undefined;
  try {
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(params.exportRootDir, collisions[0]!.selector, "metadata.json"),
        "utf8",
      ),
    ) as { sessionId?: unknown; startedAt?: unknown };
    ownerSelector = collisions.find(
      (row) => row.session_id === metadata.sessionId && row.started_at === metadata.startedAt,
    )?.selector;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  if (!ownerSelector) {
    const pendingOwners = collisions.filter((row) =>
      parseTranscriptPendingExports(row.export_pending_json).has("metadata.json"),
    );
    if (pendingOwners.length === 1) {
      ownerSelector = pendingOwners[0]?.selector;
    }
  }
  ownerSelector ??= params.selector;
  if (ownerSelector !== params.selector) {
    throw new Error(
      `transcript export path collides case-insensitively with another session: ${path.join(params.exportRootDir, params.selector)}`,
    );
  }
}

export async function hasAliasedCanonicalTranscriptExportPathOwner(
  params: ExportOwnershipParams & { owners: ReturnType<typeof readTranscriptExportPathOwners> },
): Promise<boolean> {
  const { owners } = params;
  if (owners.length === 0) {
    return false;
  }
  try {
    await fs.access(params.exportRootDir);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (await isCaseSensitiveDirectory(params.exportRootDir)) {
    return false;
  }
  const sessionDir = path.join(params.exportRootDir, params.selector);
  let entries;
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  const artifactCaseSensitive = await isCaseSensitiveDirectory(sessionDir);
  const artifacts = entries.flatMap((entry) => {
    const canonicalName = artifactCaseSensitive ? entry.name : entry.name.toLowerCase();
    return TRANSCRIPT_EXPORT_FILE_NAMES.has(canonicalName) ? [{ entry, canonicalName }] : [];
  });
  if (artifacts.length === 0) {
    return true;
  }
  let owner;
  const metadataArtifact = artifacts.find(({ canonicalName }) => canonicalName === "metadata.json");
  if (metadataArtifact) {
    const metadataPath = path.join(sessionDir, metadataArtifact.entry.name);
    const metadataStat = await fs.lstat(metadataPath);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      return false;
    }
    let handle;
    try {
      handle = await fs.open(metadataPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const metadata = JSON.parse(await handle.readFile("utf8")) as {
        sessionId?: unknown;
        startedAt?: unknown;
      };
      owner = owners.find(
        (row) => row.session_id === metadata.sessionId && row.started_at === metadata.startedAt,
      );
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }
  if (!owner && !metadataArtifact) {
    const manifestMatches = [];
    for (const candidate of owners) {
      if (await transcriptArtifactsMatchOwner(sessionDir, artifacts, candidate)) {
        manifestMatches.push(candidate);
      }
    }
    owner = manifestMatches.length === 1 ? manifestMatches[0] : undefined;
  }
  return owner !== undefined && (await transcriptArtifactsMatchOwner(sessionDir, artifacts, owner));
}
