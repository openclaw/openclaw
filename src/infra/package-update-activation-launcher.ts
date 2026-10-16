import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageActivationIdentity } from "./package-update-activation-paths.js";
import type { PackageActivationRecord } from "./package-update-activation-schema.js";
import {
  createPackageIntegrityReader,
  packageLauncherDifferences,
  type PackageLauncherFingerprint,
} from "./package-update-integrity.js";

const launcherSchema = z.tuple([
  z.enum(["symlink", "file"]),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

/** Keep the journal's version-1 launcher encoding while the live reader exposes metadata. */
export function encodePackageActivationLauncher(value: PackageLauncherFingerprint): string {
  return JSON.stringify([value.type, value.mode, value.uid, value.gid, value.contents]);
}

export function decodePackageActivationLauncher(encoded: string): PackageLauncherFingerprint {
  const [type, mode, uid, gid, contents] = launcherSchema.parse(JSON.parse(encoded));
  return { type, mode, uid, gid, contents };
}

export function matchesPackageActivationLauncher(
  actual: PackageLauncherFingerprint | null,
  encoded: string | null,
) {
  return actual === null || encoded === null
    ? actual === null && encoded === null
    : packageLauncherDifferences(decodePackageActivationLauncher(encoded), actual, {
        checkMode: true,
      }).length === 0;
}

const entryIdentity = (file: string) =>
  fs.lstatSync(file, { throwIfNoEntry: false })
    ? packageActivationIdentity(file, "launcher")
    : null;

export function assertPackageActivationSelectedLaunchers(
  record: PackageActivationRecord,
  selected: "previous" | "candidate",
) {
  const descriptor = record.descriptor;
  for (const entry of descriptor.launchers) {
    const expected =
      selected === "previous" && entry.previous === null
        ? null
        : record.phase === "aborted" || record.phase === "prepared"
          ? entry.previousIdentity
          : record.publications.find((published) => published.name === entry.name)?.identity;
    if (entryIdentity(path.join(descriptor.binDir, entry.name)) !== expected) {
      throw new Error("Selected package launcher identity changed.");
    }
  }
}
export async function verifyPackageActivationSelectedLaunchers(
  record: PackageActivationRecord,
  selected: "previous" | "candidate",
) {
  const descriptor = record.descriptor;
  const reader = createPackageIntegrityReader();
  assertPackageActivationSelectedLaunchers(record, selected);
  for (const entry of descriptor.launchers) {
    const destination = path.join(descriptor.binDir, entry.name);
    const fingerprint = (await reader.exists(destination))
      ? await reader.launcher(destination)
      : null;
    if (!matchesPackageActivationLauncher(fingerprint, entry[selected])) {
      throw new Error("Selected package launcher fingerprint changed.");
    }
  }
  assertPackageActivationSelectedLaunchers(record, selected);
}
