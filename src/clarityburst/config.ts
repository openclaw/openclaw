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
 */

export interface ClarityBurstConfig {
  enabled: boolean;
  routerUrl: string;
  timeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
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

      this.config = {
        enabled,
        routerUrl,
        timeoutMs,
        logLevel,
      };

      this.logConfiguration();
      this.initialized = true;
    } catch (error) {
      console.error('[ClarityBurst Config] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Parse CLARITYBURST_ENABLED environment variable
   */
  private parseEnabled(): boolean {
    const value = process.env.CLARITYBURST_ENABLED ?? 'true';
    const enabled = value.toLowerCase() === 'true';
    return enabled;
  }

  /**
   * Parse and validate CLARITYBURST_ROUTER_URL environment variable
   */
  private parseRouterUrl(): string {
    const url = process.env.CLARITYBURST_ROUTER_URL ?? 'http://localhost:3001';

    // Validate URL format
    try {
      new URL(url);
    } catch (err) {
      throw new Error(
        `Invalid CLARITYBURST_ROUTER_URL: "${url}". ` +
        `Must be a valid URL (e.g., https://clarity-router.example.com or http://localhost:3001). ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Warn if not HTTPS in production
    if (process.env.NODE_ENV === 'production' && !url.startsWith('https')) {
      console.warn(
        '[ClarityBurst Config] ⚠️  WARNING: CLARITYBURST_ROUTER_URL is not HTTPS in production. ' +
        'This is a security risk. Consider enabling TLS encryption.'
      );
    }

    return url;
  }

  /**
   * Parse and validate CLARITYBURST_ROUTER_TIMEOUT_MS environment variable
   */
  private parseTimeoutMs(): number {
    const timeoutStr = process.env.CLARITYBURST_ROUTER_TIMEOUT_MS ?? '1200';
    
    let timeoutMs: number;
    try {
      timeoutMs = parseInt(timeoutStr, 10);
    } catch (err) {
      throw new Error(
        `Invalid CLARITYBURST_ROUTER_TIMEOUT_MS: "${timeoutStr}". ` +
        `Must be a valid integer (milliseconds).`
      );
    }

    if (isNaN(timeoutMs)) {
      throw new Error(
        `Invalid CLARITYBURST_ROUTER_TIMEOUT_MS: "${timeoutStr}". ` +
        `Must be a valid integer (milliseconds).`
      );
    }

    // Validate bounds
    const MIN_TIMEOUT = 100;
    const MAX_TIMEOUT = 5000;

    if (timeoutMs < MIN_TIMEOUT) {
      throw new Error(
        `CLARITYBURST_ROUTER_TIMEOUT_MS is too low: ${timeoutMs}ms. ` +
        `Minimum allowed is ${MIN_TIMEOUT}ms.`
      );
    }

    if (timeoutMs > MAX_TIMEOUT) {
      throw new Error(
        `CLARITYBURST_ROUTER_TIMEOUT_MS is too high: ${timeoutMs}ms. ` +
        `Maximum allowed is ${MAX_TIMEOUT}ms.`
      );
    }

    return timeoutMs;
  }

  /**
   * Parse CLARITYBURST_LOG_LEVEL environment variable
   */
  private parseLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
    const level = process.env.CLARITYBURST_LOG_LEVEL ?? 'info';
    const validLevels = ['debug', 'info', 'warn', 'error'];

    if (!validLevels.includes(level)) {
      throw new Error(
        `Invalid CLARITYBURST_LOG_LEVEL: "${level}". ` +
        `Must be one of: ${validLevels.join(', ')}`
      );
    }

    return level as 'debug' | 'info' | 'warn' | 'error';
  }

  /**
   * Log sanitized configuration at startup
   */
  private logConfiguration(): void {
    if (!this.config) return;

    console.log('[ClarityBurst Config] Configuration loaded:');
    console.log(`  Enabled: ${this.config.enabled}`);
    console.log(`  Router URL: ${this.config.routerUrl}`);
    console.log(`  Router Timeout: ${this.config.timeoutMs}ms`);
    console.log(`  Log Level: ${this.config.logLevel}`);
  }

  /**
   * Get current configuration
   * Must call initialize() first
   */
  getConfig(): ClarityBurstConfig {
    if (!this.initialized || !this.config) {
      throw new Error(
        'ClarityBurst configuration not initialized. ' +
        'Call initialize() at application startup.'
      );
    }
    return this.config;
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
  getLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
    return this.getConfig().logLevel;
  }

  /**
   * Reset configuration (for testing)
   */
  reset(): void {
    this.config = null;
    this.initialized = false;
  }
}

// Create singleton instance
const configManager = new ClarityBurstConfigManager();

// Initialize configuration at module load (can be overridden for testing)
try {
  configManager.initialize();
} catch (error) {
  console.error('[ClarityBurst] Failed to initialize configuration at startup');
  console.error(error);
  process.exit(1);
}

export default configManager;
