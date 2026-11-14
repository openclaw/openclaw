import type { PackageManifest } from "./manifest.js";
import { validateOpenClawPackageInstallCompatibility } from "./package-compat.js";
import { hasRunnableInstalledNpmPayload } from "./update-config.js";

export async function canRetainInstalledNpmPayload(params: {
  currentHostVersion: string;
  pluginId: string;
  installPath: string;
  manifest: PackageManifest | undefined;
}): Promise<boolean> {
  // Existing installations may declare historical bare host floors.
  if (
    validateOpenClawPackageInstallCompatibility({
      currentHostVersion: params.currentHostVersion,
      pluginId: params.pluginId,
      packageMetadata: params.manifest?.openclaw,
      allowLegacyBareSemver: true,
    }) !== null
  ) {
    return false;
  }
  try {
    return await hasRunnableInstalledNpmPayload(params);
  } catch {
    // Damaged or unreadable payloads do not qualify for retention.
    return false;
  }
}
