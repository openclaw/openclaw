import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PackageActivationRecord } from "./package-update-activation-schema.js";

export function resolvePackageActivationAnchor(installKey: string): string {
  const key = createHash("sha256").update(installKey).digest("hex").slice(0, 24);
  return path.join(path.dirname(installKey), `.openclaw.package-activation-${key}`);
}

export function resolvePackageActivationControl(anchor: string): string {
  return `${anchor}.control`;
}

export function resolvePackageActivationJournalPath(anchor: string): string {
  return path.join(resolvePackageActivationControl(anchor), "operation.sqlite");
}

export function resolvePackageActivationHelper(anchor: string): string {
  return path.join(resolvePackageActivationControl(anchor), "recovery.mjs");
}

export function packageActivationIdentity(file: string, directory: boolean | "launcher"): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    stat.ino === 0n ||
    !(directory === "launcher"
      ? stat.isSymbolicLink() || stat.isFile()
      : directory
        ? stat.isDirectory() && !stat.isSymbolicLink()
        : stat.isFile()) ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Package publication object has an unsafe identity");
  }
  return `${stat.dev}:${stat.ino}`;
}

export function assertPackageActivationLayout(anchor: string): void {
  if (
    [path.join(anchor, "operation.sqlite"), `${anchor}.sqlite`, `${anchor}.recovery.mjs`].some(
      (file) => fs.lstatSync(file, { throwIfNoEntry: false }),
    )
  ) {
    throw new Error(
      "Legacy package activation artifacts require their original recovery owner; no migration is performed.",
    );
  }
}

/** A receipt is a read-only completion fact, never a grant for another effect. */
export function isPackageActivationComplete(
  anchor: string,
  record: PackageActivationRecord,
): boolean {
  if (record.phase !== "anchor-retired" || record.intent?.kind !== "unlink-helper") {
    return false;
  }
  if (record.intent.identity !== record.descriptor.helperIdentity) {
    throw new Error("Final helper unlink identity is invalid.");
  }
  for (const file of [anchor, resolvePackageActivationHelper(anchor)]) {
    try {
      fs.lstatSync(file);
      return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return true;
}
