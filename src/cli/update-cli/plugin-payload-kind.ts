import path from "node:path";
import { detectBundleManifestFormat } from "../../plugins/bundle-manifest.js";
import { pluginScanExistsSync } from "../../plugins/plugin-scan-existence-cache.js";

export type PluginInstallPayloadKind = "npm-package" | "bundle" | "unknown";

/**
 * Classify the payload kind of a plugin install directory.
 *
 * Bundle formats are detected first because a directory may contain both a
 * bundle manifest and a package.json; the runtime loader prefers the native
 * package install in that case, but for the smoke check we only need to know
 * that the directory is not an npm-only payload. Treating it as a bundle means
 * we skip the package.json requirement, which matches the observed layout of
 * format=bundle plugins.
 */
export function resolvePluginInstallPayloadKind(installPath: string): PluginInstallPayloadKind {
  if (detectBundleManifestFormat(installPath) !== null) {
    return "bundle";
  }
  if (pluginScanExistsSync(path.join(installPath, "package.json"))) {
    return "npm-package";
  }
  return "unknown";
}
