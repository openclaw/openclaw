import { z } from "zod";
import type { PackageLauncherFingerprint } from "./package-update-integrity.js";

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
