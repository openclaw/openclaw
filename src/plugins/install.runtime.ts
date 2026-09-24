/** Lazy runtime barrel for plugin installation helpers used by install flows. */
export { resolveArchiveKind } from "../infra/archive.js";
export { pathExists as fileExists, root } from "../infra/fs-safe.js";
export { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
export {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
export { installPackageDir } from "../infra/install-package-dir.js";
export {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  resolveArchiveSourcePath,
} from "../infra/install-source-utils.js";
export {
  ensureInstallTargetAvailable,
  resolveCanonicalInstallTarget,
} from "../infra/install-target.js";
export { readJson as readJsonFile } from "../infra/json-files.js";
export { validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
export { resolveCompatibilityHostVersion, resolveRuntimeServiceVersion } from "../version.js";
export { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
export {
  scanInstalledPackageDependencyTree,
  scanBundleInstallSource,
  scanFileInstallSource,
  scanPackageInstallSource,
} from "./install-security-scan.js";
export {
  getPackageManifestMetadata,
  loadPluginManifest,
  resolvePackageExtensionEntries,
} from "./manifest.js";
export { checkMinHostVersion } from "./min-host-version.js";
export { isPathInside } from "./path-safety.js";
