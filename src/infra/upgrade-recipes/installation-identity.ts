import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertUpgradeRecipeCatalogCurrent,
  type AuthenticatedUpgradeRecipeCatalog,
} from "./catalog.js";

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
const fileIdentity = z.discriminatedUnion("kind", [
  z.strictObject({
    path: relativePath,
    kind: z.literal("file"),
    length: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777),
  }),
  z.strictObject({
    path: relativePath,
    kind: z.literal("symlink"),
    target: z.string().min(1).max(1024),
  }),
]);

/** The installation manifest is a signed catalog artifact, not installed self-attestation. */
const upgradeInstallationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1),
  buildId: z.string().min(1),
  packageArtifactId: z.string().min(1),
  directories: z.array(relativePath).max(100000),
  files: z.array(fileIdentity).min(1).max(100000),
});

export type UpgradeInstallationIdentity = {
  readonly root: string;
  readonly releaseId: string;
  readonly buildId: string;
  readonly manifestArtifactId: string;
  readonly manifestDigest: string;
  readonly fileCount: number;
};

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function exactFile(
  filename: string,
  length: number,
  expectedDigest: string,
  mode?: number,
): Promise<Buffer | undefined> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== length ||
      (mode !== undefined && (before.mode & 0o777) !== mode)
    ) {
      throw new Error("Installation artifact type, size, or permission identity differs.");
    }
    const hash = createHash("sha256");
    const retained: Buffer[] = [];
    let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length;
      if (count > length) {
        throw new Error("Installation artifact grew during verification.");
      }
      hash.update(chunk);
      if (mode === undefined) {
        retained.push(chunk);
      }
    }
    const after = await handle.stat();
    const named = await fs.lstat(filename);
    if (
      count !== length ||
      hash.digest("hex") !== expectedDigest ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.isSymbolicLink()
    ) {
      throw new Error("Installation artifact digest or filesystem identity changed.");
    }
    return mode === undefined ? Buffer.concat(retained) : undefined;
  } finally {
    await handle.close();
  }
}

/** Read-only full-closure evidence. This grants neither installation ownership nor a mutation lease. */
export async function verifyAuthenticatedUpgradeInstallation(options: {
  catalog: AuthenticatedUpgradeRecipeCatalog;
  root: string;
  releaseId: string;
  artifactsDirectory: string;
  forbiddenRoots: readonly string[];
}): Promise<UpgradeInstallationIdentity> {
  assertUpgradeRecipeCatalogCurrent(options.catalog);
  const releases = options.catalog.catalog.releases.filter(
    (release) => release.id === options.releaseId,
  );
  const release = releases.length === 1 ? releases[0] : undefined;
  const manifestArtifactId = release?.installationManifestArtifactId;
  if (!release || !manifestArtifactId) {
    throw new Error("Source release lacks an authenticated installed-file manifest.");
  }
  assertUpgradeRecipeCatalogCurrent(options.catalog, {
    artifactIds: [release.artifactId, manifestArtifactId],
  });
  const artifacts = options.catalog.catalog.artifacts.filter(
    (artifact) => artifact.id === manifestArtifactId,
  );
  const artifact = artifacts.length === 1 ? artifacts[0] : undefined;
  if (!artifact || artifact.length > 20 * 1024 * 1024) {
    throw new Error("Source installation manifest lacks a bounded exact artifact identity.");
  }
  const root = path.resolve(options.root);
  const artifactRoot = path.resolve(options.artifactsDirectory);
  const rootStat = await fs.lstat(root);
  const cacheStat = await fs.lstat(artifactRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await fs.realpath(root)) !== root ||
    !cacheStat.isDirectory() ||
    cacheStat.isSymbolicLink() ||
    (await fs.realpath(artifactRoot)) !== artifactRoot ||
    (cacheStat.mode & 0o077) !== 0 ||
    (process.getuid && cacheStat.uid !== process.getuid()) ||
    within(root, artifactRoot) ||
    options.forbiddenRoots.length === 0
  ) {
    throw new Error(
      "Source identity needs canonical installation and private external artifact storage.",
    );
  }
  for (const boundary of options.forbiddenRoots) {
    if (within(await fs.realpath(boundary), artifactRoot)) {
      throw new Error(
        "Source manifest storage must be outside agent workspaces and installations.",
      );
    }
  }
  const bytes = await exactFile(
    path.join(artifactRoot, manifestArtifactId),
    artifact.length,
    artifact.sha256,
  );
  if (!bytes) {
    throw new Error("Source manifest bytes are unavailable.");
  }
  const manifest = upgradeInstallationManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    manifest.releaseId !== release.id ||
    manifest.buildId !== release.buildId ||
    manifest.packageArtifactId !== release.artifactId
  ) {
    throw new Error("Installed-file manifest is bound to another release or package artifact.");
  }
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  const directories = new Set(manifest.directories);
  if (
    files.size !== manifest.files.length ||
    directories.size !== manifest.directories.length ||
    [...directories].some((directory) => files.has(directory))
  ) {
    throw new Error("Installed-file manifest contains conflicting path identities.");
  }
  const seen = new Set<string>();
  const seenDirectories = new Set<string>();
  const identities: Array<{
    filename: string;
    dev: number;
    ino: number;
    ctimeMs: number;
    mtimeMs: number;
  }> = [];
  const walk = async (directory: string): Promise<void> => {
    const initial = await fs.lstat(directory);
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new Error("Installation directory identity changed.");
    }
    identities.push({
      filename: directory,
      dev: initial.dev,
      ino: initial.ino,
      ctimeMs: initial.ctimeMs,
      mtimeMs: initial.mtimeMs,
    });
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const stat = await fs.lstat(filename);
      if (stat.isDirectory()) {
        if (!directories.has(relative)) {
          throw new Error(
            "Installation contains an undeclared directory; local content is preserved.",
          );
        }
        seenDirectories.add(relative);
        await walk(filename);
        continue;
      }
      const declared = files.get(relative);
      if (!declared) {
        throw new Error("Installation contains an undeclared file; local content is preserved.");
      }
      if (declared.kind === "file") {
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("Installed file type differs from the authenticated manifest.");
        }
        await exactFile(filename, declared.length, declared.sha256, declared.mode);
      } else {
        const target = path.resolve(path.dirname(filename), declared.target);
        const targetRelative = path.relative(root, target).split(path.sep).join("/");
        if (
          !stat.isSymbolicLink() ||
          !within(root, target) ||
          files.get(targetRelative)?.kind !== "file" ||
          (await fs.readlink(filename)) !== declared.target ||
          (await fs.realpath(target)) !== target
        ) {
          throw new Error("Installation link target is changed, external, or undeclared.");
        }
      }
      identities.push({
        filename,
        dev: stat.dev,
        ino: stat.ino,
        ctimeMs: stat.ctimeMs,
        mtimeMs: stat.mtimeMs,
      });
      seen.add(relative);
    }
  };
  await walk(root);
  if (seen.size !== files.size || seenDirectories.size !== directories.size) {
    throw new Error("Installation closure is missing authenticated files or directories.");
  }
  for (const identity of identities) {
    const fresh = await fs.lstat(identity.filename);
    if (
      fresh.dev !== identity.dev ||
      fresh.ino !== identity.ino ||
      fresh.ctimeMs !== identity.ctimeMs ||
      fresh.mtimeMs !== identity.mtimeMs
    ) {
      throw new Error("Installation changed during full-closure verification.");
    }
  }
  assertUpgradeRecipeCatalogCurrent(options.catalog, {
    artifactIds: [release.artifactId, manifestArtifactId],
  });
  return Object.freeze({
    root,
    releaseId: release.id,
    buildId: release.buildId,
    manifestArtifactId,
    manifestDigest: artifact.sha256,
    fileCount: files.size,
  });
}
