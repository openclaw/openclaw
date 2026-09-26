// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertDirectoryIdentitySync,
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  buildRandomTempFilePath,
  copyFileDescriptorSync,
  probePathCaseInsensitiveSync,
  probePathSuffixAliasesSync,
  readFileHandleBounded,
  resolvePathPrefixSync,
  type FileIdentityStat,
  sameFileContentsSync,
  sameFileIdentity,
  sanitizeUntrustedFileName,
  tempFile,
} from "@openclaw/fs-safe/advanced";
export { FsSafeError } from "@openclaw/fs-safe/errors";
export { readSecretFile } from "@openclaw/fs-safe/secret";
