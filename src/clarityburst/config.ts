/**
 * ClarityBurst Configuration Management
 *
 * Loads and validates configuration from environment variables.
 * Fails fast at startup if configuration is invalid.
 *
 * Environment Variables:
 * - CLARITYBURST_ENABLED: Enable/disable ClarityBurst gating (default: true)
 * - CLARITYBURST_ROUTER_URL: Router service URL (default: http://localhost:3001)
 * - CLARITYBURST_ROUTER_TIMEOUT_MS: Request timeout in milliseconds (default: 1200, min: 100, max: 5000)
 * - CLARITYBURST_LOG_LEVEL: Logging level (debug|info|warn|error, default: info)
 * - CLARITYBURST_API_KEY: Bearer token for authenticating with the ClarityBurst router.
 *   Required when CLARITYBURST_ROUTER_URL points to the production Fly.io router.
 *   Omit only for local dev against start-clarityburst-router.ts (which enforces its own
 *   CLARITYBURST_ROUTER_TOKEN independently). A warning is emitted at startup when the URL
 *   is non-localhost and no key is set.
 */

export interface ClarityBurstConfig {
  enabled: boolean;
  routerUrl: string;
  timeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Bearer token sent as `Authorization: Bearer <apiKey>` on every /api/route request.
   *  null means no auth header is sent (acceptable for local dev only). */
  apiKey: string | null;
}

class ClarityBurstConfigManager {
  private config: ClarityBurstConfig | null = null;
  private initialized = false;

  /**
   * Initialize configuration from environment variables
   * This should be called once at application startup
   *
   * @throws Error if configuration is invalid
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    try {
      const enabled = this.parseEnabled();
      const routerUrl = this.parseRouterUrl();
      const timeoutMs = this.parseTimeoutMs();
      const logLevel = this.parseLogLevel();
      const apiKey = this.parseApiKey(routerUrl);

      this.config = {
        enabled,
        routerUrl,
        timeoutMs,
        logLevel,
        apiKey,
      };

      this.logConfiguration();
      this.initialized = true;
    } catch (error) {
      console.error("[ClarityBurst Config] Initialization failed:", error);
      throw error;
    }
  }

  /**
   * Parse CLARITYBURST_ENABLED environment variable
   */
  private parseEnabled(): boolean {
    const value = process.env.CLARITYBURST_ENABLED ?? "true";
    const wantsDisabled = value.toLowerCase() !== "true";

    if (wantsDisabled && process.env.NODE_ENV === "production") {
      if (process.env.CLARITYBURST_FORCE_DISABLE === "1") {
        console.warn(
          "[ClarityBurst Config] ⚠️  CRITICAL: ClarityBurst FORCE DISABLED in production via CLARITYBURST_FORCE_DISABLE=1. All gating bypassed.",
        );
        return false;
      }
      console.warn(
        "[ClarityBurst Config] ⚠️  CRITICAL: Ignoring CLARITYBURST_ENABLED=false in production. Set CLARITYBURST_FORCE_DISABLE=1 to override.",
      );
      return true;
    }

    return !wantsDisabled;
  }

  /**
   * Parse and validate CLARITYBURST_ROUTER_URL environment variable
   */
  private parseRouterUrl(): string {
    const url = process.env.CLARITYBURST_ROUTER_URL;

    if (!url || url.trim() === "") {
      throw new Error(
        "CLARITYBURST_ROUTER_URL is required when ClarityBurst is enabled. " +
          "Set it to the router URL (e.g., https://clarityburst-router.fly.dev).",
      );
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (err) {
      throw new Error(
        `Invalid CLARITYBURST_ROUTER_URL: "${url}". ` +
          `Must be a valid URL (e.g., https://clarity-router.example.com or http://localhost:3001). ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // Warn if not HTTPS in production
    if (process.env.NODE_ENV === "production" && !url.startsWith("https")) {
      console.warn(
        "[ClarityBurst Config] ⚠️  WARNING: CLARITYBURST_ROUTER_URL is not HTTPS in production. " +
          "This is a security risk. Consider enabling TLS encryption.",
      );
    }

    return url;
  }

  /**
   * Parse and validate CLARITYBURST_ROUTER_TIMEOUT_MS environment variable
   */
  private parseTimeoutMs(): number {
    const timeoutStr = process.env.CLARITYBURST_ROUTER_TIMEOUT_MS ?? "1200";

    let timeoutMs: number;
    try {
      timeoutMs = parseInt(timeoutStr, 10);
    } catch (_err) {
      throw new Error(
        `Invalid CLARITYBURST_ROUTER_TIMEOUT_MS: "${timeoutStr}". ` +
          `Must be a valid integer (milliseconds).`,
        { cause: _err },
      );
    }

    if (isNaN(timeoutMs)) {
      throw new Error(
        `Invalid CLARITYBURST_ROUTER_TIMEOUT_MS: "${timeoutStr}". ` +
          `Must be a valid integer (milliseconds).`,
      );
    }

    // Validate bounds
    const MIN_TIMEOUT = 100;
    const MAX_TIMEOUT = 5000;

    if (timeoutMs < MIN_TIMEOUT) {
      throw new Error(
        `CLARITYBURST_ROUTER_TIMEOUT_MS is too low: ${timeoutMs}ms. ` +
          `Minimum allowed is ${MIN_TIMEOUT}ms.`,
      );
    }

    if (timeoutMs > MAX_TIMEOUT) {
      throw new Error(
        `CLARITYBURST_ROUTER_TIMEOUT_MS is too high: ${timeoutMs}ms. ` +
          `Maximum allowed is ${MAX_TIMEOUT}ms.`,
      );
    }

    return timeoutMs;
  }

  /**
   * Parse CLARITYBURST_API_KEY environment variable.
   * Returns the trimmed key string, or null if not set.
   * Emits a startup warning when the router URL is not localhost and no key is configured —
   * every request will be rejected 401 by the production Fly.io router in that state.
   */
  private parseApiKey(routerUrl: string): string | null {
    const raw = (process.env.CLARITYBURST_API_KEY ?? "").trim();
    if (!raw) {
      // Only warn when the router URL is not a local address — localhost stubs
      // use their own token scheme and don't require this key.
      const isLocal = routerUrl.includes("localhost") || routerUrl.includes("127.0.0.1");
      if (!isLocal) {
        console.warn(
          "[ClarityBurst Config] ⚠️  WARNING: CLARITYBURST_API_KEY is not set but " +
            `CLARITYBURST_ROUTER_URL points to a remote host (${routerUrl}). ` +
            "Every routing request will be rejected with 401 Unauthorized. " +
            "Set CLARITYBURST_API_KEY to a valid API key provisioned in the router's api_keys table.",
        );
      }
      return null;
    }
    return raw;
  }

  /**
   * Parse CLARITYBURST_LOG_LEVEL environment variable
   */
  private parseLogLevel(): "debug" | "info" | "warn" | "error" {
    const level = process.env.CLARITYBURST_LOG_LEVEL ?? "info";
    const validLevels = ["debug", "info", "warn", "error"];

    if (!validLevels.includes(level)) {
      throw new Error(
        `Invalid CLARITYBURST_LOG_LEVEL: "${level}". ` +
          `Must be one of: ${validLevels.join(", ")}`,
      );
    }

    return level as "debug" | "info" | "warn" | "error";
  }

  /**
   * Log sanitized configuration at startup
   */
  private logConfiguration(): void {
    if (!this.config) {
      return;
    }

    console.log("[ClarityBurst Config] Configuration loaded:");
    console.log(`  Enabled: ${this.config.enabled}`);
    console.log(`  Router URL: ${this.config.routerUrl}`);
    console.log(`  Router Timeout: ${this.config.timeoutMs}ms`);
    console.log(`  Log Level: ${this.config.logLevel}`);
    // Log key presence only — never log the key value itself.
    const apiKeyStatus = this.config.apiKey
      ? `set (ends …${this.config.apiKey.slice(-4)})`
      : "not set";
    console.log(`  API Key: ${apiKeyStatus}`);

    if (!this.config.enabled) {
      console.warn(
        "[ClarityBurst Config] ⚠️  WARNING: ClarityBurst is DISABLED (CLARITYBURST_ENABLED=false). All gating decisions are bypassed.",
      );
    }
  }

  /**
   * Get current configuration.
   * Lazily initializes on first call so that process.env values are read
   * after the normal OpenClaw env/config loading pipeline has run, not at
   * module import time.
   */
  getConfig(): ClarityBurstConfig {
    if (!this.initialized || !this.config) {
      this.initialize();
    }
    // initialize() either succeeded (this.config is set) or threw — safe cast.
    return this.config!;
  }

  /**
   * Check if ClarityBurst is enabled
   */
  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  /**
   * Get router URL
   */
  getRouterUrl(): string {
    return this.getConfig().routerUrl;
  }

  /**
   * Get router timeout in milliseconds
   */
  getTimeoutMs(): number {
    return this.getConfig().timeoutMs;
  }

  /**
   * Get log level
   */
  getLogLevel(): "debug" | "info" | "warn" | "error" {
    return this.getConfig().logLevel;
  }

  /**
   * Get API key for authenticating with the ClarityBurst router.
   * Returns null when CLARITYBURST_API_KEY is not set (local dev only).
   */
  getApiKey(): string | null {
    return this.getConfig().apiKey;
  }

  /**
   * Reset configuration (for testing)
   */
  reset(): void {
    this.config = null;
    this.initialized = false;
  }
}

// Create singleton instance — initialization is deferred to first getConfig()
// call so that CLARITYBURST_ROUTER_URL (and other env vars) are read after the
// normal OpenClaw env/config loading pipeline has already run.
const configManager = new ClarityBurstConfigManager();

export default configManager;
