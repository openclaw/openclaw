import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readWorkerBundleDirectoryManifest } from "../../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../../shared/worker-bundle-hash.js";
import { resolvePathViaExistingAncestorSync } from "../boundary-path.js";
import {
  assertUpgradeRecipeCatalogCurrent,
  type AuthenticatedUpgradeRecipeCatalog,
} from "./catalog.js";
import type { VerifiedUpgradeRecipeRunnerBundle } from "./runner-bundle-contract.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const relativePath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value.length > 0 &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      path.posix.normalize(value) === value &&
      value !== ".." &&
      !value.startsWith("../"),
  );
export const upgradeRecipeRunnerBundleManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocol: z.literal(1),
  purpose: z.enum(["production", "release-qualification"]).optional(),
  platform: z.strictObject({
    os: z.enum(["linux", "darwin", "win32"]),
    arch: z.enum(["x64", "arm64"]),
  }),
  runtime: z.strictObject({
    path: relativePath,
    kind: z.literal("node"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
  entrypoint: relativePath,
  bootstrapArtifactId: z.string().min(1),
  releaseQualificationEntrypoint: relativePath.optional(),
  externalModules: z.array(z.never()).length(0),
  files: z
    .array(
      z.strictObject({
        path: relativePath,
        artifactId: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        length: z.number().int().positive(),
        executable: z.boolean(),
        role: z.enum(["runtime", "runner", "native-dependency", "data"]),
      }),
    )
    .min(2)
    .max(10000),
});
export type UpgradeRecipeRunnerBundleManifest = z.infer<
  typeof upgradeRecipeRunnerBundleManifestSchema
>;
export type { VerifiedUpgradeRecipeRunnerBundle } from "./runner-bundle-contract.js";
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
async function requirePrivate(file: string, directory: boolean): Promise<void> {
  const stat = await fs.lstat(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(file)) !== file
  ) {
    throw new Error("Runner bundle must use private canonical installation-owner files.");
  }
}

/** Passive validation only. A verified bundle never grants an update lease or starts its runtime. */
export async function verifyUpgradeRecipeRunnerBundle(options: {
  catalog: AuthenticatedUpgradeRecipeCatalog;
  bundleRoot: string;
  manifestArtifactId: string;
  forbiddenRoots: readonly string[];
  platform?: { os: "linux" | "darwin" | "win32"; arch: "x64" | "arm64" };
}): Promise<VerifiedUpgradeRecipeRunnerBundle> {
  assertUpgradeRecipeCatalogCurrent(options.catalog, { artifactIds: [options.manifestArtifactId] });
  const root = path.resolve(options.bundleRoot);
  if (
    options.forbiddenRoots.length === 0 ||
    options.forbiddenRoots.some((boundary) =>
      inside(resolvePathViaExistingAncestorSync(path.resolve(boundary)), root),
    )
  ) {
    throw new Error("Retained runner must be outside agent workspaces and replaced installations.");
  }
  await requirePrivate(root, true);
  const manifestPath = path.join(root, "runner-manifest.json");
  await requirePrivate(manifestPath, false);
  if ((await fs.stat(manifestPath)).size > MAX_MANIFEST_BYTES) {
    throw new Error("Runner manifest exceeds its byte limit.");
  }
  const bytes = await fs.readFile(manifestPath);
  const manifestArtifact = options.catalog.catalog.artifacts.filter(
    (artifact) => artifact.id === options.manifestArtifactId,
  );
  const artifact = manifestArtifact[0];
  const manifestDigest = createHash("sha256").update(bytes).digest("hex");
  if (
    manifestArtifact.length !== 1 ||
    !artifact ||
    bytes.length > MAX_MANIFEST_BYTES ||
    bytes.length !== artifact.length ||
    manifestDigest !== artifact.sha256
  ) {
    throw new Error("Runner manifest does not match its authenticated artifact identity.");
  }
  const manifest = upgradeRecipeRunnerBundleManifestSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  const platform = options.platform ?? { os: process.platform, arch: process.arch };
  if (manifest.platform.os !== platform.os || manifest.platform.arch !== platform.arch) {
    throw new Error("Runner bundle is not qualified for this operating system and architecture.");
  }
  const [major, minor, patch] = manifest.runtime.version.split(".").map(Number);
  if (
    !major ||
    minor === undefined ||
    patch === undefined ||
    !(
      (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
      (major === 24 && minor >= 15) ||
      major >= 26
    )
  ) {
    throw new Error(
      "Private runner runtime does not meet the maintained TUF client runtime contract.",
    );
  }
  const paths = new Set(manifest.files.map((file) => file.path));
  if (paths.size !== manifest.files.length || paths.has("runner-manifest.json")) {
    throw new Error("Runner manifest contains duplicate or self-referential files.");
  }
  const runtime = manifest.files.filter((file) => file.role === "runtime");
  const runner = manifest.files.filter((file) => file.role === "runner");
  if (
    runtime.length !== 1 ||
    runtime[0]?.path !== manifest.runtime.path ||
    !runtime[0].executable ||
    runner.length !== (manifest.releaseQualificationEntrypoint ? 2 : 1) ||
    !runner.some((file) => file.path === manifest.entrypoint) ||
    (manifest.releaseQualificationEntrypoint !== undefined &&
      (manifest.releaseQualificationEntrypoint === manifest.entrypoint ||
        !runner.some((file) => file.path === manifest.releaseQualificationEntrypoint)))
  ) {
    throw new Error("Runner manifest lacks an exact private runtime and sealed entrypoint.");
  }
  assertUpgradeRecipeCatalogCurrent(options.catalog, {
    artifactIds: [...manifest.files.map((file) => file.artifactId), manifest.bootstrapArtifactId],
  });
  for (const file of manifest.files) {
    const identities = options.catalog.catalog.artifacts.filter(
      (entry) => entry.id === file.artifactId,
    );
    const identity = identities[0];
    if (
      identities.length !== 1 ||
      !identity ||
      identity.sha256 !== file.sha256 ||
      identity.length !== file.length
    ) {
      throw new Error("Runner dependency closure differs from authenticated artifact identities.");
    }
    await requirePrivate(path.join(root, file.path), false);
    for (
      let parent = path.dirname(path.join(root, file.path));
      parent !== root;
      parent = path.dirname(parent)
    ) {
      await requirePrivate(parent, true);
    }
  }
  const observed = await readWorkerBundleDirectoryManifest({
    root,
    limits: { maxEntries: 10000, maxExpandedBytes: MAX_BUNDLE_BYTES },
    ignoreTopLevel: new Set(["runner-manifest.json"]),
  });
  if (observed.length !== manifest.files.length) {
    throw new Error("Runner bundle contains missing or undeclared dependencies.");
  }
  for (const file of manifest.files) {
    const actual = observed.find((entry) => entry.path === file.path);
    if (
      !actual ||
      actual.sha256 !== file.sha256 ||
      actual.size !== file.length ||
      (process.platform !== "win32" && Boolean(actual.mode & 0o100) !== file.executable)
    ) {
      throw new Error("Runner dependency bytes or executable mode changed.");
    }
  }
  // Recheck freshness/revocation after potentially expensive dependency hashing.
  assertUpgradeRecipeCatalogCurrent(options.catalog, {
    artifactIds: [
      options.manifestArtifactId,
      ...manifest.files.map((file) => file.artifactId),
      manifest.bootstrapArtifactId,
    ],
  });
  return Object.freeze({
    root,
    purpose: manifest.purpose ?? "production",
    manifestDigest,
    closureDigest: hashWorkerBundleManifest(observed),
    runtimePath: path.join(root, manifest.runtime.path),
    entrypointPath: path.join(root, manifest.entrypoint),
    releaseQualificationEntrypointPath: manifest.releaseQualificationEntrypoint
      ? path.join(root, manifest.releaseQualificationEntrypoint)
      : undefined,
    runtimeArtifactId: runtime[0].artifactId,
    bootstrapArtifactId: manifest.bootstrapArtifactId,
    nativeDependencies: Object.freeze(
      manifest.files.filter((file) => file.role === "native-dependency").map((file) => file.path),
    ),
  });
}
