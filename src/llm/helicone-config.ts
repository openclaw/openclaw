/**
 * Helicone Configuration — Phase 1: Foundation
 *
 * Helicone provides observability, caching, and rate limiting for LLM calls.
 * @see https://docs.helicone.ai/
 */

// ============================================================================
// Configuration
// ============================================================================

/** Helicone proxy base URL for OpenAI */
export const HELICONE_BASE_URL = "https://oai.helicone.ai/v1";

/** Helicone proxy base URL for Anthropic */
export const HELICONE_ANTHROPIC_BASE_URL = "https://anthropic.helicone.ai/v1";

/** Helicone proxy base URL for Google/Gemini */
export const HELICONE_GOOGLE_BASE_URL = "https://gateway.helicone.ai/v1/gemini";

// ============================================================================
// Header Factory
// ============================================================================

export interface HeliconeHeadersOptions {
  /** User identifier for request grouping */
  userId?: string;
  /** Session identifier for related requests */
  sessionId?: string;
  /** Custom request ID for tracing */
  requestId?: string;
  /** Enable response caching */
  cacheEnabled?: boolean;
  /** Cache bucket size for rate limiting */
  cacheBucketMaxSize?: number;
  /** Rate limit policy */
  rateLimitPolicy?: string;
  /** Retry policy on failure */
  retryEnabled?: boolean;
  /** Number of retries */
  retryNum?: number;
  /** Enable prompt tracking */
  promptTrackingEnabled?: boolean;
  /** Custom properties for filtering */
  properties?: Record<string, string>;
  /** Feature flags */
  features?: {
    /** Enable fallbacks on failure */
    fallbackEnabled?: boolean;
    /** Enable memory for conversations */
    memoryEnabled?: boolean;
    /** Enable moderation */
    moderationEnabled?: boolean;
  };
}

/**
 * Create Helicone headers for request tracking
 */
export function createHeliconeHeaders(
  userId: string = "anonymous",
  sessionId: string = "default",
  options: HeliconeHeadersOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "Helicone-Auth": `Bearer ${getHeliconeApiKey()}`,
    "Helicone-User-Id": userId,
    "Helicone-Session-Id": sessionId,
  };

  // Request ID for tracing
  if (options.requestId) {
    headers["Helicone-Request-Id"] = options.requestId;
  }

  // Caching
  if (options.cacheEnabled !== false) {
    headers["Helicone-Cache-Enabled"] = "true";
  }

  if (options.cacheBucketMaxSize) {
    headers["Helicone-Cache-Bucket-Max-Size"] = String(options.cacheBucketMaxSize);
  }

  // Rate limiting
  if (options.rateLimitPolicy) {
    headers["Helicone-RateLimit-Policy"] = options.rateLimitPolicy;
  }

  // Retry configuration
  if (options.retryEnabled) {
    headers["Helicone-Retry-Enabled"] = "true";
    if (options.retryNum) {
      headers["Helicone-Retry-Num"] = String(options.retryNum);
    }
  }

  // Prompt tracking
  if (options.promptTrackingEnabled) {
    headers["Helicone-Prompt-Tracking"] = "true";
  }

  // Custom properties (for filtering in dashboard)
  if (options.properties) {
    for (const [key, value] of Object.entries(options.properties)) {
      headers[`Helicone-Property-${key}`] = value;
    }
  }

  // Feature flags
  if (options.features?.fallbackEnabled) {
    headers["Helicone-Fallback-Enabled"] = "true";
  }

  if (options.features?.memoryEnabled) {
    headers["Helicone-Memory-Enabled"] = "true";
  }

  if (options.features?.moderationEnabled) {
    headers["Helicone-Moderation-Enabled"] = "true";
  }

  return headers;
}

// ============================================================================
// Provider-Specific Configurations
// ============================================================================

/**
 * Create OpenAI client configuration with Helicone
 */
export function createOpenAIHeliconeConfig(
  userId: string,
  sessionId: string,
  options?: HeliconeHeadersOptions,
) {
  return {
    baseURL: HELICONE_BASE_URL,
    defaultHeaders: createHeliconeHeaders(userId, sessionId, options),
  };
}

/**
 * Create Anthropic client configuration with Helicone
 */
export function createAnthropicHeliconeConfig(
  userId: string,
  sessionId: string,
  options?: HeliconeHeadersOptions,
) {
  return {
    baseURL: HELICONE_ANTHROPIC_BASE_URL,
    defaultHeaders: createHeliconeHeaders(userId, sessionId, options),
  };
}

/**
 * Create Google/Gemini client configuration with Helicone
 */
export function createGoogleHeliconeConfig(
  userId: string,
  sessionId: string,
  options?: HeliconeHeadersOptions,
) {
  return {
    baseURL: HELICONE_GOOGLE_BASE_URL,
    defaultHeaders: createHeliconeHeaders(userId, sessionId, options),
  };
}

// ============================================================================
// Utilities
// ============================================================================

function getHeliconeApiKey(): string {
  const key = process.env.HELICONE_API_KEY;
  if (!key) {
    throw new Error("HELICONE_API_KEY environment variable is required");
  }
  return key;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// Rate Limiting Policies
// ============================================================================

export const RateLimitPolicies = {
  /** Conservative: 10 requests per minute */
  CONSERVATIVE: "10;w=60",
  /** Standard: 60 requests per minute */
  STANDARD: "60;w=60",
  /** Aggressive: 1000 requests per minute */
  AGGRESSIVE: "1000;w=60",
  /** Burst: 100 requests per 10 seconds */
  BURST: "100;w=10",
} as const;

// ============================================================================
// Dashboard Helpers
// ============================================================================

/**
 * Build Helicone dashboard URL for filtering
 */
export function buildDashboardUrl(filters: {
  userId?: string;
  sessionId?: string;
  startDate?: Date;
  endDate?: Date;
  status?: "success" | "error";
}): string {
  const baseUrl = "https://www.helicone.ai/requests";
  const params = new URLSearchParams();

  if (filters.userId) {
    params.set("user", filters.userId);
  }

  if (filters.sessionId) {
    params.set("session", filters.sessionId);
  }

  if (filters.startDate) {
    params.set("start", filters.startDate.toISOString());
  }

  if (filters.endDate) {
    params.set("end", filters.endDate.toISOString());
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  return `${baseUrl}?${params.toString()}`;
}

/**
 * Get request details URL
 */
export function getRequestUrl(requestId: string): string {
  return `https://www.helicone.ai/requests/${requestId}`;
}
