/**
 * Cloud.ru AI Fabric — Constants
 *
 * Single Source of Truth for AI Agents API integration constants.
 */

/** Base URL for Cloud.ru AI Agents API (v1). */
export const CLOUDRU_AI_AGENTS_BASE_URL = "https://ai-agents.api.cloud.ru/api/v1";

/** IAM token exchange endpoint. */
export const CLOUDRU_IAM_TOKEN_URL = "https://iam.api.cloud.ru/api/v1/auth/token";

/** Default HTTP request timeout in milliseconds. */
export const CLOUDRU_DEFAULT_TIMEOUT_MS = 30_000;

/** Refresh the IAM token this many ms before its expiry. */
export const CLOUDRU_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000; // 5 minutes

/** Default retry configuration for API calls. */
export const CLOUDRU_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} as const;

/** Default page size for paginated list endpoints. */
export const CLOUDRU_DEFAULT_PAGE_SIZE = 20;

/** Backoff policy for polling A2A task status (agent-system orchestrators). */
export const CLOUDRU_A2A_POLL_POLICY = {
  initialMs: 1_000,
  maxMs: 5_000,
  factor: 1.5,
  jitter: 0.1,
} as const;
