/**
 * Configuration for enhanced logging features.
 *
 * All enhanced logging can be toggled via environment variables or config file.
 * Priority: env vars > config file > defaults
 * Default: All features enabled.
 *
 * Environment Variables:
 * - CLAWDBRAIN_ENHANCED_LOGGING=0       - Disable all enhanced logging (global override)
 * - CLAWDBRAIN_LOG_TOOL_ERRORS=0        - Disable detailed tool error logging
 * - CLAWDBRAIN_LOG_PERFORMANCE=0        - Disable performance outlier detection
 * - CLAWDBRAIN_LOG_TOKEN_WARNINGS=0     - Disable token budget warnings
 * - CLAWDBRAIN_LOG_GATEWAY_HEALTH=0     - Disable gateway health logging
 *
 * Config File (openclaw.json):
 * {
 *   "logging": {
 *     "enhanced": {
 *       "toolErrors": true,
 *       "performanceOutliers": true,
 *       "tokenWarnings": true,
 *       "gatewayHealth": false
 *     }
 *   }
 * }
 */

export type EnhancedLoggingConfig = {
  /** Log detailed context when tool calls fail */
  toolErrors: boolean;
  /** Log operations that exceed performance thresholds */
  performanceOutliers: boolean;
  /** Log warnings when approaching token limits */
  tokenWarnings: boolean;
  /** Log gateway connection state changes */
  gatewayHealth: boolean;
};

/**
 * Performance thresholds for outlier detection (milliseconds)
 */
export type PerformanceThresholds = {
  /** Tool execution threshold (default: 5000ms) */
  toolCall: number;
  /** Agent turn threshold (default: 30000ms) */
  agentTurn: number;
  /** Gateway request threshold (default: 10000ms) */
  gatewayRequest: number;
  /** Database operation threshold (default: 2000ms) */
  databaseOp: number;
};

/**
 * Token usage warning thresholds (percentage of context window)
 */
export type TokenWarningThresholds = {
  /** Warning threshold (default: 75%) */
  warning: number;
  /** Critical threshold (default: 90%) */
  critical: number;
};

const DEFAULT_CONFIG: EnhancedLoggingConfig = {
  toolErrors: true,
  performanceOutliers: true,
  tokenWarnings: true,
  gatewayHealth: true,
};

const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceThresholds = {
  toolCall: 5000,
  agentTurn: 30000,
  gatewayRequest: 10000,
  databaseOp: 2000,
};

const DEFAULT_TOKEN_THRESHOLDS: TokenWarningThresholds = {
  warning: 75,
  critical: 90,
};

let cachedConfig: EnhancedLoggingConfig | null = null;
let cachedPerformanceThresholds: PerformanceThresholds | null = null;
let cachedTokenThresholds: TokenWarningThresholds | null = null;

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Get enhanced logging configuration.
 * Cached for performance.
 * Priority: env vars > config file > defaults
 */
export function getEnhancedLoggingConfig(): EnhancedLoggingConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  // Global override to disable all enhanced logging
  if (process.env.CLAWDBRAIN_ENHANCED_LOGGING === "0") {
    cachedConfig = {
      toolErrors: false,
      performanceOutliers: false,
      tokenWarnings: false,
      gatewayHealth: false,
    };
    return cachedConfig;
  }

  // Try to load from config file (synchronous to avoid async issues)
  let configEnhanced: typeof DEFAULT_CONFIG | undefined;
  try {
    // Use require to synchronously load config
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require("../config/config.js");
    const cfg = loadConfig();
    configEnhanced = cfg.logging?.enhanced;
  } catch {
    // Config not available or error loading, use env vars + defaults only
  }

  cachedConfig = {
    toolErrors: envFlag(
      "CLAWDBRAIN_LOG_TOOL_ERRORS",
      configEnhanced?.toolErrors ?? DEFAULT_CONFIG.toolErrors,
    ),
    performanceOutliers: envFlag(
      "CLAWDBRAIN_LOG_PERFORMANCE",
      configEnhanced?.performanceOutliers ?? DEFAULT_CONFIG.performanceOutliers,
    ),
    tokenWarnings: envFlag(
      "CLAWDBRAIN_LOG_TOKEN_WARNINGS",
      configEnhanced?.tokenWarnings ?? DEFAULT_CONFIG.tokenWarnings,
    ),
    gatewayHealth: envFlag(
      "CLAWDBRAIN_LOG_GATEWAY_HEALTH",
      configEnhanced?.gatewayHealth ?? DEFAULT_CONFIG.gatewayHealth,
    ),
  };

  return cachedConfig;
}

/**
 * Get performance thresholds for outlier detection.
 * Priority: env vars > config file > defaults
 */
export function getPerformanceThresholds(): PerformanceThresholds {
  if (cachedPerformanceThresholds) {
    return cachedPerformanceThresholds;
  }

  // Try to load from config file
  let configThresholds: typeof DEFAULT_PERFORMANCE_THRESHOLDS | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require("../config/config.js");
    const cfg = loadConfig();
    configThresholds = cfg.logging?.performanceThresholds;
  } catch {
    // Config not available, use env vars + defaults only
  }

  cachedPerformanceThresholds = {
    toolCall:
      Number(process.env.CLAWDBRAIN_PERF_TOOL_MS) ||
      configThresholds?.toolCall ||
      DEFAULT_PERFORMANCE_THRESHOLDS.toolCall,
    agentTurn:
      Number(process.env.CLAWDBRAIN_PERF_TURN_MS) ||
      configThresholds?.agentTurn ||
      DEFAULT_PERFORMANCE_THRESHOLDS.agentTurn,
    gatewayRequest:
      Number(process.env.CLAWDBRAIN_PERF_GATEWAY_MS) ||
      configThresholds?.gatewayRequest ||
      DEFAULT_PERFORMANCE_THRESHOLDS.gatewayRequest,
    databaseOp:
      Number(process.env.CLAWDBRAIN_PERF_DB_MS) ||
      configThresholds?.databaseOp ||
      DEFAULT_PERFORMANCE_THRESHOLDS.databaseOp,
  };

  return cachedPerformanceThresholds;
}

/**
 * Get token warning thresholds (percentage of context window).
 * Priority: env vars > config file > defaults
 */
export function getTokenWarningThresholds(): TokenWarningThresholds {
  if (cachedTokenThresholds) {
    return cachedTokenThresholds;
  }

  // Try to load from config file
  let configThresholds: typeof DEFAULT_TOKEN_THRESHOLDS | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require("../config/config.js");
    const cfg = loadConfig();
    configThresholds = cfg.logging?.tokenWarningThresholds;
  } catch {
    // Config not available, use env vars + defaults only
  }

  cachedTokenThresholds = {
    warning:
      Number(process.env.CLAWDBRAIN_TOKEN_WARN_PCT) ||
      configThresholds?.warning ||
      DEFAULT_TOKEN_THRESHOLDS.warning,
    critical:
      Number(process.env.CLAWDBRAIN_TOKEN_CRIT_PCT) ||
      configThresholds?.critical ||
      DEFAULT_TOKEN_THRESHOLDS.critical,
  };

  return cachedTokenThresholds;
}

/**
 * Reset cached config (for testing).
 */
export function resetEnhancedLoggingConfig(): void {
  cachedConfig = null;
  cachedPerformanceThresholds = null;
  cachedTokenThresholds = null;
}
