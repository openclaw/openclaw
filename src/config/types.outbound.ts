/**
 * Configuration for outbound message safeguards.
 *
 * Add this type as an optional `outbound?: OutboundConfig` field on
 * OpenClawConfig in src/config/types.openclaw.ts.
 *
 * Example openclaw.json snippet:
 *
 *   "outbound": {
 *     "rateLimit": {
 *       "enabled": true,
 *       "maxMessages": 20,
 *       "windowMs": 60000,
 *       "cooldownMs": 120000
 *     },
 *     "dedup": {
 *       "enabled": true,
 *       "windowMs": 30000,
 *       "maxDuplicates": 2
 *     }
 *   }
 */

export interface OutboundRateLimitConfig {
  /** Enable outbound rate limiting per recipient. @default true */
  enabled?: boolean;
  /** Max messages per recipient per window. @default 20 */
  maxMessages?: number;
  /** Sliding window duration in ms. @default 60_000 */
  windowMs?: number;
  /** Cool-down duration in ms after the limit is hit. @default 120_000 */
  cooldownMs?: number;
}

export interface OutboundDedupConfig {
  /** Enable duplicate-message detection. @default true */
  enabled?: boolean;
  /** Window in ms during which identical messages are counted. @default 30_000 */
  windowMs?: number;
  /** Max times the same message may be sent before being blocked. @default 2 */
  maxDuplicates?: number;
}

export interface OutboundConfig {
  rateLimit?: OutboundRateLimitConfig;
  dedup?: OutboundDedupConfig;
}
