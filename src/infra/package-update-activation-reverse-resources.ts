import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  assertLauncherImage,
  assertPackageReverseImage,
  assertReverseParents,
  readPackageReverseImage,
} from "./package-update-activation-reverse-files.js";
import type { PackageActivationReverseResource } from "./package-update-activation-reverse-schema.js";

export type PackageReverseResourceCustody = {
  /** Observed original inodes, not permission to publish or restart. */
  packageResources: readonly PackageActivationReverseResource[];
  /** Only the original package parent's device is owned by this transaction.
   * Other volumes need their existing resource owner's staging contract. */
  stagingParent: (live: string) => string;
};

/** Read the original publication's retained resources. No new directories,
 * journal revisions, backup copies, target admission, or replacement owners. */
export async function readPackageReverseResourceCustody(
  record: PackageActivationRecord,
  assertOwner: () => void,
): Promise<PackageReverseResourceCustody> {
  const d = record.descriptor;
  const live = d.authority.installKey;
  const anchor = resolvePackageActivationAnchor(live);
  const parent = path.dirname(anchor);
  const launcherRoot = path.join(anchor, "previous-launchers");
  const assertCurrent = () => {
    assertOwner();
    if (
      packageActivationIdentity(parent, true) !== d.parentIdentity ||
      (d.previousLauncherRootIdentity &&
        packageActivationIdentity(launcherRoot, true) !== d.previousLauncherRootIdentity)
    ) {
      throw new Error("Original reverse resource parent custody changed.");
    }
  };
  const parentIdentity = (file: string) => packageActivationIdentity(path.dirname(file), true);
  const packageResources: PackageActivationReverseResource[] = [];
  const add = async (
    role: "package" | "launcher",
    destination: string,
    staged: string | null,
    displaced: string,
  ) => {
    assertCurrent();
    const before = await readPackageReverseImage(
      destination,
      role === "package" ? d.originalStageRoot : undefined,
    );
    assertCurrent();
    const after = staged
      ? await readPackageReverseImage(staged, role === "package" ? live : undefined)
      : before;
    assertCurrent();
    const resource: PackageActivationReverseResource = {
      role,
      live: destination,
      parentIdentity: parentIdentity(destination),
      before,
      after,
      move: staged
        ? {
            staged,
            displaced,
            stagedParentIdentity: parentIdentity(staged),
            displacedParentIdentity: parentIdentity(displaced),
          }
        : null,
    };
    assertReverseParents(resource);
    if (staged && fs.lstatSync(displaced, { throwIfNoEntry: false })) {
      throw new Error("Original reverse displacement slot is occupied.");
    }
    packageResources.push(resource);
  };
  assertCurrent();
  if (packageActivationIdentity(parent, true) !== d.parentIdentity) {
    throw new Error("Original package parent changed.");
  }
  await add("package", live, path.join(anchor, "previous"), path.join(anchor, "candidate"));
  const pkg = packageResources[0]!;
  for (const [image, expected] of [
    [pkg.before, d.candidate],
    [pkg.after, d.previous],
  ] as const) {
    if (
      image.kind !== "package" ||
      !isDeepStrictEqual(
        { digest: image.digest, identity: image.identity, version: image.version },
        expected,
      )
    ) {
      throw new Error("Original reverse package pair changed.");
    }
  }
  for (const [index, entry] of d.launchers.entries()) {
    const destination = path.join(d.binDir, entry.name);
    const unchanged = entry.previous === entry.candidate;
    if (!unchanged && !d.previousLauncherRootIdentity) {
      throw new Error("Original launcher backup custody is unavailable.");
    }
    const staged = unchanged ? null : path.join(launcherRoot, entry.name);
    const displaced = path.join(d.binDir, `.openclaw-reverse-${d.operationId}-${index}`);
    if (d.launchers.some((other) => path.join(d.binDir, other.name) === displaced)) {
      throw new Error("Original reverse launcher slots overlap.");
    }
    // Capture once and validate those exact bytes, metadata and inode. Later
    // reobservation can reject change but cannot replace the admitted image.
    await add("launcher", destination, staged, displaced);
    const resource = packageResources.at(-1)!;
    const published = record.publications.find((item) => item.name === entry.name);
    if (resource.before.kind === "missing" || resource.before.identity !== published?.identity) {
      throw new Error("Original published launcher inode changed.");
    }
    assertLauncherImage(resource.before, entry.candidate);
    assertLauncherImage(resource.after, entry.previous);
    assertCurrent();
  }
  // Reobserve the exact captured images before returning after awaited reads.
  for (const resource of packageResources) {
    assertCurrent();
    assertReverseParents(resource);
    await assertPackageReverseImage(resource.live, resource.before, d);
    if (resource.move) {
      await assertPackageReverseImage(resource.move.staged, resource.after, d);
      if (fs.lstatSync(resource.move.displaced, { throwIfNoEntry: false })) {
        throw new Error("Original reverse displacement slot changed.");
      }
    }
    assertCurrent();
  }
  return {
    packageResources,
    stagingParent(file) {
      assertCurrent();
      if (path.resolve(file) !== file) {
        throw new Error("Reverse state path must be canonical and absolute.");
      }
      const liveParent = path.dirname(file);
      const stat = fs.lstatSync(liveParent, { bigint: true });
      if (
        !stat.isDirectory() ||
        fs.realpathSync(liveParent) !== liveParent ||
        fs.realpathSync(parent) !== parent ||
        packageActivationIdentity(parent, true) !== d.parentIdentity ||
        String(stat.dev) !== d.parentIdentity.split(":")[0]
      ) {
        throw new Error("Reverse state requires its original same-device staging owner.");
      }
      return parent;
    },
  };
}
