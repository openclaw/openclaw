/** Public security runtime helpers for plugin-side trust boundaries. */

export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  fileExists,
  readRegularFile,
  readRegularFileSync,
  statRegularFile,
  statRegularFileSync,
} from "./file-access-runtime.js";

export {
  buildChannelMetadata,
  buildUntrustedChannelMetadata,
} from "../security/channel-metadata.js";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "../security/context-visibility.js";
export type { ContextVisibilityDecision } from "../security/context-visibility.js";

export {
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
} from "./access-groups.js";
export {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "../security/external-content.js";
export { compileSafeRegexDetailed } from "../security/safe-regex.js";
export type { SafeRegexRejectReason } from "../security/safe-regex.js";
export {
  appendRegularFile,
  FsSafeError,
  openLocalFileSafely,
  pathExists,
  pathExistsSync,
  resolveLocalPathFromRootsSync,
  root,
  writeExternalFileWithinRoot,
  withTimeout,
} from "../infra/fs-safe.js";

export { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
export { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
export { normalizeHostname } from "../infra/net/hostname.js";
export {
  SsrFBlockedError,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
export type { LookupFn, SsrFPolicy } from "../infra/net/ssrf.js";
export { isPathInside } from "../infra/path-guards.js";
export {
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
} from "../infra/fs-safe.js";
export { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
export { privateFileStoreSync } from "../infra/private-file-store.js";
export { movePathWithCopyFallback, replaceFileAtomic } from "../infra/replace-file.js";

export { ensurePortAvailable } from "../infra/ports.js";

export {
  resolveExistingPathsWithinRoot,
  pathScope,
  resolveStrictExistingPathsWithinRoot,
} from "../infra/root-paths.js";

export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
/**
 * Redact text with optional mode ("tools" or "off") and ordered patterns.
 * Nonempty patterns replace the default string rules; form-body, structured-auth,
 * and AWS bare-key protections still apply. Entries accept strings, RegExp, or
 * synchronous matchers. Registered secrets still redact in "off" mode. sensitiveFieldPatterns
 * applies to structured redaction and is unused by this text function.
 *
 * A matcher has source: string and exec(input), returning a fresh iterable of
 * { match, groups: string[], input, offset }. Offsets are UTF-16 code units in the
 * current input after registered-secret and earlier-pattern replacement. Emit exact,
 * nonempty matches in order without overlap; keep cursors/state local to each call.
 * The last nonempty capture is the secret (its last occurrence within match);
 * with no capture, the whole match is masked. Use "" for unmatched captures.
 * Executable entries are programmatic only; logging.redactPatterns stores strings.
 * See https://docs.openclaw.ai/plugins/sdk-subpaths#sensitive-text-redaction.
 */
export { redactSensitiveText } from "../logging/redact.js";
export { safeEqualSecret } from "../security/secret-equal.js";

export { resolvePinnedMainDmOwnerFromAllowlist } from "../security/dm-policy-shared.js";
