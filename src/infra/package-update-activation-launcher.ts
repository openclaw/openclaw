import type { PackageLauncherFingerprint } from "./package-update-integrity.js";

/** Keep the journal's version-1 launcher encoding while the live reader exposes metadata. */
export function encodePackageActivationLauncher(value: PackageLauncherFingerprint): string {
  return JSON.stringify([value.type, value.mode, value.uid, value.gid, value.contents]);
}
