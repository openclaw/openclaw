import { z } from "zod";
import {
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

function decodePackageActivationLauncher(encoded: string): PackageLauncherFingerprint {
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
