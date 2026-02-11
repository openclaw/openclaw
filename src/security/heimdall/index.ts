/**
 * Heimdall Security Layer — Public API
 *
 * Deterministic enforcement: GATE → SANITIZE → AUTHORIZE → FILTER
 */

export type {
  HeimdallConfig,
  HeimdallAuditConfig,
  HeimdallRateLimitConfig,
  RateLimitResult,
  SecurityContext,
  SenderTier,
  SenderTiersConfig,
  ToolACLEntry,
  OutputFilterConfig,
  OutputFilterPattern,
  RedactionMatch,
  RedactionResult,
  SanitizeConfig,
  SanitizeResult,
  SanitizeWarning,
} from "./types.js";

export { SenderTier as SenderTierEnum } from "./types.js";

// GATE
export { resolveSenderTier } from "./sender-tier.js";

// AUTHORIZE
export { isToolAllowed, globToRegex } from "./tool-acl.js";

// SANITIZE
export { sanitizeInput } from "./sanitize.js";

// FILTER
export { redactOutput, BUILTIN_PATTERNS } from "./output-filter.js";
export { applyOutputFilter } from "./apply-filter.js";
export { wrapBlockReplyWithFilter } from "./streaming-filter.js";
export { DEPLOYMENT_PATTERNS } from "./patterns.js";

// CONFIG
export { resolveHeimdallConfig } from "./resolve-config.js";
export { HeimdallSchema, HeimdallRateLimitSchema, HeimdallAuditSchema } from "./config-schema.js";

// RATE LIMIT
export { HeimdallRateLimiter, getHeimdallRateLimiter } from "./rate-limit.js";

// AUDIT
export { createHeimdallAuditLogger, getHeimdallAuditLogger } from "./audit.js";
