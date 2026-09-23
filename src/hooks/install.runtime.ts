/** Lazy facade kept separate so hook metadata paths do not eagerly load install tooling. */
export { resolveArchiveKind } from "../infra/archive.js";
export { pathExists as fileExists } from "../infra/fs-safe.js";
export { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
export { installFromValidatedNpmSpecArchive } from "../infra/install-from-npm-spec.js";
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
export { isPathInside, isPathInsideWithRealpath } from "../security/scan-paths.js";
