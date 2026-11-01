// Retained artifact and extracted-source provenance for public ClawHub Templates.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { readTemplateManifestFile } from "./reader.js";
import type { TemplateReadResult } from "./types.js";

const TEMPLATE_SOURCE_CACHE_DIR = "templates/sources";
export const CLAWHUB_TIMEOUT_MS = 30_000;

export type ResolvedClawHubSource = Extract<TemplateReadResult, { ok: true }>;

export class ClawHubSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly warning?: string,
  ) {
    super(message);
    this.name = "ClawHubSourceError";
  }
}

async function sourceDirectoriesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.lstat(left), fs.lstat(right)]);
  if (!leftStat.isDirectory() || !rightStat.isDirectory()) {
    return false;
  }
  const [leftEntries, rightEntries] = await Promise.all([
    fs.readdir(left, { withFileTypes: true }),
    fs.readdir(right, { withFileTypes: true }),
  ]);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]));
  for (const leftEntry of leftEntries) {
    const rightEntry = rightByName.get(leftEntry.name);
    if (!rightEntry) {
      return false;
    }
    const leftPath = path.join(left, leftEntry.name);
    const rightPath = path.join(right, leftEntry.name);
    if (leftEntry.isDirectory() && rightEntry.isDirectory()) {
      if (!(await sourceDirectoriesMatch(leftPath, rightPath))) {
        return false;
      }
    } else if (leftEntry.isFile() && rightEntry.isFile()) {
      if (!(await fs.readFile(leftPath)).equals(await fs.readFile(rightPath))) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

async function archiveMatches(
  archivePath: string,
  expectedSha256: string,
  expectedByteLength: number,
): Promise<boolean> {
  const entry = await fs.lstat(archivePath).catch(() => undefined);
  if (!entry?.isFile() || entry.size !== expectedByteLength) {
    return false;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex") === expectedSha256;
}

export async function persistExtractedSource(params: {
  rootDir: string;
  archivePath: string;
  artifactSha256: string;
  artifactByteLength: number;
  stateDir?: string;
}): Promise<string> {
  const cacheRoot = path.join(params.stateDir ?? resolveStateDir(), TEMPLATE_SOURCE_CACHE_DIR);
  const destination = path.join(cacheRoot, params.artifactSha256);
  const retainedArchive = path.join(cacheRoot, `${params.artifactSha256}.tgz`);
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(cacheRoot, ".staging-"));
  const stagedPackage = path.join(staging, "package");
  const stagedArchive = path.join(staging, "source.tgz");
  try {
    await fs.cp(params.rootDir, stagedPackage, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    await fs.copyFile(params.archivePath, stagedArchive);
    if (!(await archiveMatches(stagedArchive, params.artifactSha256, params.artifactByteLength))) {
      throw new ClawHubSourceError(
        "clawhub_artifact_integrity_mismatch",
        "The staged Template archive differs from the verified release artifact.",
      );
    }
    try {
      await fs.link(stagedArchive, retainedArchive);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }
      if (
        !(await archiveMatches(retainedArchive, params.artifactSha256, params.artifactByteLength))
      ) {
        throw new ClawHubSourceError(
          "clawhub_cached_artifact_mismatch",
          "A retained Template archive differs from the verified release artifact.",
        );
      }
    }
    try {
      await fs.rename(stagedPackage, destination);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
        throw error;
      }
      if (!(await sourceDirectoriesMatch(stagedPackage, destination))) {
        throw new ClawHubSourceError(
          "clawhub_cached_source_mismatch",
          "A cached Template source differs from the verified release artifact.",
        );
      }
    }
    return destination;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function readVerifiedArtifactSource(params: {
  sourceRoot: string;
  packageName: string;
  version: string;
  artifactSha256: string;
  artifactByteLength: number;
}): Promise<ResolvedClawHubSource> {
  const loaded = await readTemplateManifestFile(params.sourceRoot, {
    allowPublishedLegacyClawSelector: true,
  });
  if (!loaded.ok) {
    throw new ClawHubSourceError(
      "clawhub_manifest_invalid",
      "Downloaded Template package manifest is invalid.",
    );
  }
  if (
    loaded.source.kind !== "package" ||
    loaded.source.name !== params.packageName ||
    loaded.source.version !== params.version
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "Downloaded Template package identity does not match the selected release.",
    );
  }
  return {
    ...loaded,
    source: {
      ...loaded.source,
      integrityKind: "artifact",
      integrity: `sha256:${params.artifactSha256}`,
      byteLength: params.artifactByteLength,
    },
  };
}
