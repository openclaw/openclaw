import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  packageActivationIdentity,
  type PackageActivationDescriptor,
} from "./package-update-activation-journal.js";
import {
  readPackageReverseImage,
  reverseFileDigest,
} from "./package-update-activation-reverse-files.js";
import { packageActivationReverseBindingSchema } from "./package-update-activation-reverse-schema.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";

const selectedRuntimeSchema = packageActivationReverseBindingSchema.shape.target.omit({
  admissionSha256: true,
  startupProtocol: true,
});

export function selectedOriginalRoot(
  anchor: string,
  descriptor: PackageActivationDescriptor,
): string {
  const matches = [path.join(anchor, "previous"), descriptor.authority.installKey].filter(
    (root) => {
      if (!fs.lstatSync(root, { throwIfNoEntry: false })) {
        return false;
      }
      return packageActivationIdentity(root, true) === descriptor.previous.identity;
    },
  );
  if (matches.length !== 1 || fs.realpathSync(matches[0]!) !== matches[0]) {
    throw new Error("Selected original runtime location is missing or ambiguous.");
  }
  return matches[0]!;
}

/** Bind the selected package image and its external Node before and after preflight. */
export async function assertSelectedOriginalRuntime(
  root: string,
  descriptor: PackageActivationDescriptor,
) {
  const runtime = selectedRuntimeSchema.parse(descriptor.previousRuntime);
  if (
    !isDeepStrictEqual(
      await createPackageIntegrityReader().tree(root, descriptor.authority.installKey),
      descriptor.previous,
    ) ||
    runtime.inventoryDigest !== descriptor.previous.digest ||
    fs.realpathSync(runtime.nodePath) !== runtime.nodePath ||
    !isDeepStrictEqual(
      await readPackageReverseImage(runtime.nodePath, undefined, true),
      runtime.node,
    ) ||
    reverseFileDigest(path.join(root, runtime.entrypoint)) !== runtime.entrypointSha256 ||
    reverseFileDigest(path.join(root, "package.json")) !== runtime.packageManifestSha256 ||
    reverseFileDigest(path.join(root, "dist/build-info.json")) !== runtime.buildInfoSha256
  ) {
    throw new Error("Selected original runtime image changed.");
  }
  const build = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  if (
    build.commit !== runtime.sourceCommit ||
    build.buildId !== runtime.buildId ||
    [".openclaw-lifecycle-pending", "dist/openclaw-install-guard"].some((name) =>
      fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }),
    )
  ) {
    throw new Error("Selected original runtime build is changed or incomplete.");
  }
  return runtime;
}
