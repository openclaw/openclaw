export {
  canAccess,
  canAccessSync,
  executableFileExists,
  executableFileExistsSync,
  lstatIfExists,
  pathEntryExists,
  readDirectoryEntriesSync,
  safeStat,
} from "../infra/path-existence.js";
export { hasNodeErrorCode, isNotFoundPathError, safeStatSync } from "@openclaw/fs-safe/path";
