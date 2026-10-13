/**
 * Public SDK subpath for temporary file and workspace helpers.
 */
export {
  buildRandomTempFilePath,
  createTempDownloadTarget,
  resolvePreferredOpenClawTmpDir,
  sanitizeTempFileName,
  withTempDownloadPath,
} from "../infra/temp-download.js";
export {
  tempWorkspaceSync,
  type TempWorkspaceOptions,
  type TempWorkspaceSync,
  withTempWorkspaceSync,
} from "@openclaw/fs-safe/temp";

export {
  tempWorkspace,
  withTempWorkspace,
  type CompatibleTempWorkspace as TempWorkspace,
} from "../infra/fs-safe-compat.js";
