import { fileExists, readJsonFile, resolveArchiveKind } from "../infra/archive.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installFromValidatedNpmSpecArchive } from "../infra/install-from-npm-spec.js";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
import {
  installPackageDir,
  installPackageDirWithManifestDeps,
} from "../infra/install-package-dir.js";
import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  resolveArchiveSourcePath,
} from "../infra/install-source-utils.js";
import {
  ensureInstallTargetAvailable,
  resolveCanonicalInstallTarget,
} from "../infra/install-target.js";
import { isPathInside, isPathInsideWithRealpath } from "../security/scan-paths.js";

export type { NpmIntegrityDrift, NpmSpecResolution };

export {
  ensureInstallTargetAvailable,
  fileExists,
  installFromValidatedNpmSpecArchive,
  installPackageDir,
  installPackageDirWithManifestDeps,
  isPathInside,
  isPathInsideWithRealpath,
  readJsonFile,
  resolveArchiveKind,
  resolveArchiveSourcePath,
  resolveCanonicalInstallTarget,
  resolveExistingInstallPath,
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
  withExtractedArchiveRoot,
};
