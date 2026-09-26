import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { Root } from "@openclaw/fs-safe";
import {
  LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
  WORKSPACE_DOCTOR_CLAIM_SUFFIX,
} from "../agents/workspace-legacy-state.js";
import { pinDirectory, requireDirectorySync } from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { LegacyMigrationSourceClaim } from "./state-migrations.source-snapshot.js";
import type { SourceSnapshot } from "./state-migrations.workspace-setup-store.js";
import type { LegacyWorkspaceStateSource } from "./state-migrations.workspace-setup.types.js";

const SETUP_MAX_BYTES = 64 * 1024;
const CLAIM_SUFFIX = WORKSPACE_DOCTOR_CLAIM_SUFFIX;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

async function readBoundedRegularFile(params: {
  sourceRoot: Root;
  relativePath: string;
  sourcePath: string;
  maxBytes: number;
}): Promise<SourceSnapshot> {
  const { buffer, stat } = await params.sourceRoot.read(params.relativePath, {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: params.maxBytes,
  });
  let raw: string;
  try {
    raw = utf8Decoder.decode(buffer);
  } catch {
    throw new Error("legacy workspace source is not valid UTF-8");
  }
  return {
    sourcePath: params.sourcePath,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: buffer.length,
    raw,
    buffer,
  };
}

export async function archiveWorkspaceSetupSource(
  sourceRoot: Root,
  source: LegacyWorkspaceStateSource,
  snapshot: SourceSnapshot,
  existingArchivePath?: string,
): Promise<string> {
  const archivePath =
    existingArchivePath ?? `${source.sourcePath}.migrated.${snapshot.sha256}.${randomUUID()}`;
  const relativePath = path.relative(source.rootDir, archivePath);
  // The receipt publishes only a verified backup. A crash during creation leaves
  // an unreferenced artifact, so the next attempt can safely use a fresh name.
  if (!existingArchivePath) {
    const parent = await pinDirectory(await sourceRoot.resolve(path.dirname(relativePath)));
    try {
      // Buffered exclusive creation avoids native no-replace rename on FUSE.
      await sourceRoot.create(relativePath, snapshot.buffer, {
        mode: 0o600,
        renameIdentity: "verify-content-with-lock",
        durable: "file",
      });
      requireDirectorySync(await parent.sync(), "Workspace setup archive directory");
    } finally {
      await parent.close();
    }
  }
  const archived = await readBoundedRegularFile({
    sourceRoot,
    relativePath,
    sourcePath: archivePath,
    maxBytes: SETUP_MAX_BYTES,
  });
  if (archived.sha256 !== snapshot.sha256) {
    throw new Error(`workspace setup backup differs from the claimed source: ${archivePath}`);
  }
  return archivePath;
}

export function createLegacySourceClaim(
  sourceRoot: Root,
  source: LegacyWorkspaceStateSource,
): LegacyMigrationSourceClaim<SourceSnapshot> {
  return new LegacyMigrationSourceClaim({
    stateRoot: sourceRoot,
    stateDir: source.rootDir,
    sourcePath: source.sourcePath,
    label: "workspace",
    claimSuffix: CLAIM_SUFFIX,
    formatError: formatErrorMessage,
    readSnapshot: (sourcePath) =>
      readBoundedRegularFile({
        sourceRoot,
        relativePath:
          sourcePath === source.sourcePath
            ? source.relativePath
            : `${source.relativePath}${CLAIM_SUFFIX}`,
        sourcePath,
        maxBytes:
          source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
      }),
  });
}
