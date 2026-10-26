/** Lazy facade kept separate so hook metadata paths do not eagerly load install tooling. */
export { resolveArchiveKind } from "../infra/archive.js";
export { pathExists as fileExists } from "../infra/fs-safe.js";
export { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
export {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
export { installPackageDir } from "../infra/install-package-dir.js";
export {
  packNpmSpecToArchive,
  resolveArchiveSourcePath,
  withInstallWorkspace,
} from "../infra/install-source-utils.js";
export {
  ensureInstallTargetAvailable,
  resolveCanonicalInstallTarget,
} from "../infra/install-target.js";
export { readJson as readJsonFile } from "../infra/json-files.js";
export { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
export {
  formatPrereleaseResolutionError,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpecResult,
} from "../infra/npm-registry-spec.js";
export { isPathInside, isPathInsideWithRealpath } from "../security/scan-paths.js";
