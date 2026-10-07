// Retained artifact and extracted-source provenance for official ClawHub Claws.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { resolveStateDir } from "../config/paths.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { buildClawProject } from "./project-build.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawReadResult, ClawSourceIdentity } from "./types.js";

export const CLAW_SOURCE_CACHE_DIR = "claws/sources";
export const CLAWHUB_TIMEOUT_MS = 30_000;

export type ResolvedClawHubSource = Extract<ClawReadResult, { ok: true }>;

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

export async function sourceDirectoriesMatch(left: string, right: string): Promise<boolean> {
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

export async function withVerifiedCachedClawHubSource<T>(params: {
  recorded: ClawSourceIdentity;
  stateDir?: string;
  run: (sourceRoot: string) => Promise<T>;
}): Promise<T> {
  const { recorded } = params;
  const digest = /^sha256:([a-f0-9]{64})$/.exec(recorded.integrity)?.[1];
  if (
    recorded.kind !== "package" ||
    recorded.integrityKind !== "artifact" ||
    !digest ||
    !Number.isSafeInteger(recorded.byteLength) ||
    recorded.byteLength <= 0
  ) {
    throw new ClawHubSourceError(
      "clawhub_recorded_artifact_mismatch",
      "The recorded Claw artifact identity is invalid.",
    );
  }
  const cacheRoot = path.join(params.stateDir ?? resolveStateDir(), CLAW_SOURCE_CACHE_DIR);
  const sourceRoot = path.join(cacheRoot, digest);
  const [sourceEntry, canonicalRoot, canonicalRecordedRoot] = await Promise.all([
    fs.lstat(sourceRoot).catch(() => undefined),
    fs.realpath(sourceRoot).catch(() => undefined),
    fs.realpath(recorded.packageRoot).catch(() => undefined),
  ]);
  if (!sourceEntry?.isDirectory() || !canonicalRoot || canonicalRoot !== canonicalRecordedRoot) {
    throw new ClawHubSourceError(
      "clawhub_recorded_source_unavailable",
      "The recorded Claw source is not in the verified ClawHub cache.",
    );
  }
  const retainedArchive = path.join(cacheRoot, `${digest}.tgz`);
  const retainedEntry = await fs.lstat(retainedArchive).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  await using temporary = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claw-export-artifact-",
  });
  const snapshot = temporary.path("source.tgz");
  if (retainedEntry) {
    if (!(await archiveMatches(retainedArchive, digest, recorded.byteLength))) {
      throw new ClawHubSourceError(
        "clawhub_cached_artifact_mismatch",
        "The retained Claw archive differs from the recorded release artifact.",
      );
    }
    await fs.copyFile(retainedArchive, snapshot);
    if (!(await archiveMatches(snapshot, digest, recorded.byteLength))) {
      throw new ClawHubSourceError(
        "clawhub_cached_artifact_mismatch",
        "The retained Claw archive changed while preparing the export.",
      );
    }
  } else {
    const rebuilt = await buildClawProject(sourceRoot, snapshot);
    if (
      rebuilt.integrity !== recorded.integrity ||
      rebuilt.byteLength !== recorded.byteLength ||
      rebuilt.claw.name !== recorded.name ||
      rebuilt.claw.version !== recorded.version
    ) {
      throw new ClawHubSourceError(
        "clawhub_cached_artifact_mismatch",
        "The cached Claw source does not reproduce the recorded release artifact.",
      );
    }
  }
  const extracted = await withExtractedArchiveRoot({
    archivePath: snapshot,
    tempDirPrefix: "openclaw-claw-export-source-",
    timeoutMs: CLAWHUB_TIMEOUT_MS,
    rootMarkers: ["package.json", "CLAW.md", "claw.json"],
    onExtracted: async (verifiedRoot) => {
      const verified = await readVerifiedArtifactSource({
        sourceRoot: verifiedRoot,
        packageName: recorded.name,
        version: recorded.version,
        artifactSha256: digest,
        artifactByteLength: recorded.byteLength,
      });
      if (
        path.relative(recorded.packageRoot, recorded.manifestPath) !==
          path.relative(verifiedRoot, verified.source.manifestPath) ||
        !(await sourceDirectoriesMatch(sourceRoot, verifiedRoot))
      ) {
        throw new ClawHubSourceError(
          "clawhub_cached_source_mismatch",
          "The recorded Claw source differs from the verified release artifact.",
        );
      }
      return { ok: true as const, value: await params.run(verifiedRoot) };
    },
  });
  if (!extracted.ok || !("value" in extracted)) {
    throw new ClawHubSourceError("clawhub_extract_failed", extracted.error);
  }
  return extracted.value;
}

export async function persistExtractedSource(params: {
  rootDir: string;
  archivePath: string;
  artifactSha256: string;
  artifactByteLength: number;
  stateDir?: string;
}): Promise<string> {
  const cacheRoot = path.join(params.stateDir ?? resolveStateDir(), CLAW_SOURCE_CACHE_DIR);
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
        "The staged Claw archive differs from the verified release artifact.",
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
          "A retained Claw archive differs from the verified release artifact.",
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
          "A cached Claw source differs from the verified release artifact.",
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
  const loaded = await readClawManifestFile(params.sourceRoot);
  if (!loaded.ok) {
    throw new ClawHubSourceError(
      "clawhub_manifest_invalid",
      "Downloaded Claw package manifest is invalid.",
    );
  }
  if (
    loaded.source.kind !== "package" ||
    loaded.source.name !== params.packageName ||
    loaded.source.version !== params.version
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "Downloaded Claw package identity does not match the selected release.",
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
