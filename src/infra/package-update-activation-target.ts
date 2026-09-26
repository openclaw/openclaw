import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import {
  readPackageReverseImage,
  readReverseFile,
  reverseFileDigest,
} from "./package-update-activation-reverse-files.js";
import { packageActivationPreviousRuntimeSchema } from "./package-update-activation-reverse-schema.js";
import {
  createPackageIntegrityReader,
  type PackageIntegrityFingerprint,
} from "./package-update-integrity.js";

/** Selection happens once, under the original fence and before displacement.
 * Missing historical metadata remains explicit and disables reverse admission;
 * it does not forbid an otherwise supported forward update. No current process
 * executable or unrelated package can fill missing selection on recovery. */
export async function capturePackageActivationPreviousRuntime(params: {
  root: string;
  previous: PackageIntegrityFingerprint;
  nodePath: string;
  nodeVersion: string;
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const node = await readPackageReverseImage(params.nodePath, undefined, true);
  if (node.kind !== "file") {
    throw new Error("Original external Node is not a regular executable.");
  }
  const entry = await resolveGatewayInstallEntrypoint(params.root);
  const buildFile = path.join(params.root, "dist/build-info.json");
  const buildStat = fs.lstatSync(buildFile, { throwIfNoEntry: false });
  let build: Record<string, unknown> = {};
  let buildInfoSha256: string | null = null;
  if (buildStat) {
    if (
      !buildStat.isFile() ||
      buildStat.size > 1024 * 1024 ||
      fs.realpathSync(buildFile) !== buildFile
    ) {
      throw new Error("Original build metadata is unsafe.");
    }
    buildInfoSha256 = reverseFileDigest(buildFile);
    const value: unknown = JSON.parse(readReverseFile(buildFile, 1024 * 1024).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // SAFETY: JSON.parse returned a non-null, non-array object; values remain unknown.
      build = value as Record<string, unknown>;
    }
    if (buildInfoSha256 !== reverseFileDigest(buildFile)) {
      throw new Error("Original build metadata changed.");
    }
  }
  if (entry && (!fs.lstatSync(entry).isFile() || fs.realpathSync(entry) !== entry)) {
    throw new Error("Original bootstrap entrypoint is unsafe.");
  }
  const result = packageActivationPreviousRuntimeSchema.parse({
    packageManifestSha256: reverseFileDigest(path.join(params.root, "package.json")),
    buildInfoSha256,
    buildId: typeof build.buildId === "string" && build.buildId.length > 0 ? build.buildId : null,
    sourceCommit:
      typeof build.commit === "string" && /^[a-f0-9]{40}$/u.test(build.commit)
        ? build.commit
        : null,
    inventoryDigest: params.previous.digest,
    nodePath: params.nodePath,
    node,
    nodeVersion: params.nodeVersion,
    entrypoint: entry ? path.relative(params.root, entry) : null,
    entrypointSha256: entry ? reverseFileDigest(entry) : null,
  });
  if (
    !isDeepStrictEqual(params.previous, await createPackageIntegrityReader().tree(params.root)) ||
    !isDeepStrictEqual(node, await readPackageReverseImage(params.nodePath, undefined, true))
  ) {
    throw new Error("Original runtime changed during selection.");
  }
  params.assertCurrent();
  return result;
}
