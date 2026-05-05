// Public security/policy helpers for plugins that need shared trust and DM gating logic.

export * from "../secrets/channel-secret-collector-runtime.js";
export * from "../secrets/runtime-shared.js";
export * from "../secrets/shared.js";
export type * from "../secrets/target-registry-types.js";
export * from "../security/channel-metadata.js";
export * from "../security/context-visibility.js";
export * from "../security/dm-policy-shared.js";
export {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
  resolveAccessGroupAllowFromMatches,
  type AccessGroupMembershipResolver,
} from "./access-groups.js";
export * from "../security/external-content.js";
export * from "../security/safe-regex.js";
export {
  appendRegularFile,
  appendRegularFileSync,
  FsSafeError,
  pathExists,
  pathExistsSync,
  readPrivateJson,
  readPrivateJsonSync,
  readPrivateText,
  readPrivateTextSync,
  resolveLocalPathFromRootsSync,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  root,
  statRegularFileSync,
  withTimeout,
} from "../infra/fs-safe.js";
export { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
export { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
export { normalizeHostname } from "../infra/net/hostname.js";
export {
  SsrFBlockedError,
  isBlockedHostnameOrIp,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
export { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
export {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
  type AbsolutePathSymlinkPolicy,
  type ResolvedAbsolutePath,
  type ResolvedWritableAbsolutePath,
} from "../infra/fs-safe.js";
export { sanitizeUntrustedFileName } from "../infra/filename.js";
export {
  privateFileStore,
  writePrivateJsonAtomic,
  writePrivateJsonAtomicSync,
  writePrivateTextAtomic,
  writePrivateTextAtomicSync,
  type PrivateFileStore,
} from "../infra/private-file-store.js";
export {
  replaceFileAtomic,
  replaceFileAtomicSync,
  type ReplaceFileAtomicFileSystem,
  type ReplaceFileAtomicOptions,
  type ReplaceFileAtomicResult,
  type ReplaceFileAtomicSyncFileSystem,
  type ReplaceFileAtomicSyncOptions,
} from "../infra/replace-file.js";
export {
  movePathWithCopyFallback,
  type MovePathWithCopyFallbackOptions,
} from "../infra/move-path.js";
export {
  writeSiblingTempFile,
  type WriteSiblingTempFileOptions,
  type WriteSiblingTempFileResult,
} from "../infra/sibling-temp-file.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  type AssertNoSymlinkParentsOptions,
} from "../infra/symlink-parents.js";
export { ensurePortAvailable } from "../infra/ports.js";
export { generateSecureToken } from "../infra/secure-random.js";
export {
  resolveExistingPathsWithinRoot,
  pathScope,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../infra/root-paths.js";
export { writeViaSiblingTempPath } from "../infra/sibling-temp-write.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { redactSensitiveText } from "../logging/redact.js";
export { safeEqualSecret } from "../security/secret-equal.js";
