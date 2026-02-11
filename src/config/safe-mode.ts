/**
 * Safe Mode Configuration for OpenClaw
 * 
 * Provides a minimal, safe configuration for recovery scenarios when the main
 * configuration is broken or causes startup failures. Safe mode reduces
 * functionality to core operations only.
 */

import type { OpenClawConfig } from "./types.js";

export type SafeModeOptions = {
  /** Whether to enable any external channels (default: false for maximum safety) */
  enableChannels?: boolean;
  /** Whether to enable custom agents (default: false) */
  enableCustomAgents?: boolean;
  /** Whether to enable plugins (default: false) */
  enablePlugins?: boolean;
  /** Whether to enable cron jobs (default: false) */
  enableCron?: boolean;
  /** Whether to enable browser control (default: false) */
  enableBrowser?: boolean;
  /** Gateway port to use (default: auto-assigned) */
  gatewayPort?: number;
  /** Admin password for recovery access */
  adminPassword?: string;
  /** Allowed admin IPs/networks */
  adminAllowedIps?: string[];
};

/**
 * Check if OpenClaw is running in safe mode
 */
export function isSafeModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(
    env.OPENCLAW_SAFE_MODE === "1" || 
    env.OPENCLAW_SAFE_MODE === "true" || 
    env.OPENCLAW_SAFE_MODE === "on"
  );
}

/**
 * Get safe mode options from environment variables
 */
export function getSafeModeOptions(env: NodeJS.ProcessEnv = process.env): SafeModeOptions {
  return {
    enableChannels: env.OPENCLAW_SAFE_MODE_CHANNELS === "true",
    enableCustomAgents: env.OPENCLAW_SAFE_MODE_AGENTS === "true", 
    enablePlugins: env.OPENCLAW_SAFE_MODE_PLUGINS === "true",
    enableCron: env.OPENCLAW_SAFE_MODE_CRON === "true",
    enableBrowser: env.OPENCLAW_SAFE_MODE_BROWSER === "true",
    gatewayPort: env.OPENCLAW_SAFE_MODE_PORT ? parseInt(env.OPENCLAW_SAFE_MODE_PORT, 10) : undefined,
    adminPassword: env.OPENCLAW_SAFE_MODE_PASSWORD,
    adminAllowedIps: env.OPENCLAW_SAFE_MODE_ALLOWED_IPS?.split(",").map(ip => ip.trim()).filter(Boolean),
  };
}

/**
 * Generate a minimal safe configuration for recovery
 */
export function createSafeModeConfig(options: SafeModeOptions = {}): OpenClawConfig {
  const safeConfig: OpenClawConfig = {
    // Meta information
    meta: {
      version: "1.0.0",
      lastTouchedAt: new Date().toISOString(),
      lastTouchedVersion: "safe-mode",
      notes: "Generated safe mode configuration for recovery",
    },

    // Gateway configuration - minimal and secure
    gateway: {
      host: "127.0.0.1", // localhost only for security
      port: options.gatewayPort || 0, // auto-assign port if not specified
      auth: {
        mode: "token",
        token: options.adminPassword || generateSecureToken(),
        allowedOrigins: ["http://localhost", "https://localhost"],
        enforceSecure: false, // Allow HTTP on localhost for recovery
      },
      cors: {
        enabled: false, // Disable CORS for security
      },
      remote: {
        enabled: false, // Disable remote access
      },
      reloadOnConfigChange: false, // Disable auto-reload in safe mode
      maxRequestSize: "1MB", // Minimal request size
    },

    // Logging - verbose for debugging recovery issues
    logging: {
      level: "info",
      timestamp: true,
      colorize: false, // Better for log files during recovery
    },

    // Models - only basic models for core functionality
    models: {
      defaults: {
        chat: "gpt-3.5-turbo", // Conservative default
        image: "", // Disable image models
        voice: "", // Disable voice models
      },
      providers: {
        openai: {
          apiKey: "${OPENAI_API_KEY}",
          baseUrl: "https://api.openai.com/v1",
        },
      },
    },

    // Agents - minimal configuration
    agents: {
      defaults: {
        model: "gpt-3.5-turbo",
        maxTokens: 1000, // Conservative limit
        temperature: 0.1, // Low temperature for consistent behavior
        timeout: 30000, // 30 second timeout
        thinking: "off", // Disable thinking mode to save tokens
        retries: 1, // Minimal retries
      },
      list: options.enableCustomAgents ? [] : [
        {
          id: "recovery",
          name: "Recovery Assistant",
          description: "Minimal assistant for configuration recovery",
          model: "gpt-3.5-turbo",
          maxTokens: 500,
          systemPrompt: "You are a recovery assistant. Help the user fix OpenClaw configuration issues. Be concise and focus on essential operations only.",
          capabilities: ["read", "write"], // Basic file operations only
        },
      ],
    },

    // Session configuration - restrictive
    session: {
      maxHistory: 10, // Keep minimal history
      pruning: {
        enabled: true,
        maxAge: 3600000, // 1 hour
        maxTokens: 1000,
      },
    },

    // Tools - minimal set for recovery operations
    tools: {
      allowlist: [
        "read",
        "write", 
        "exec", // For recovery commands
        "config.*", // Config operations
      ],
      security: "allowlist", // Strict security
      exec: {
        security: "allowlist",
        allowlist: [
          "ls", "cat", "pwd", "echo", // Basic file operations
          "ps", "top", "df", "free", // System inspection
          "openclaw", // OpenClaw commands
        ],
        timeout: 10000, // 10 second timeout
      },
    },

    // Channels - disabled by default for security
    channels: options.enableChannels ? {
      // Enable minimal local-only channels if requested
      web: {
        enabled: true,
        host: "127.0.0.1",
        port: 0, // Auto-assign
        auth: {
          required: true,
          token: options.adminPassword || generateSecureToken(),
        },
      },
    } : {},

    // Plugins - disabled for safety
    plugins: options.enablePlugins ? {} : {
      enabled: false,
      autoEnable: false,
    },

    // Cron - disabled to prevent automated actions
    cron: options.enableCron ? {} : {
      enabled: false,
    },

    // Browser - disabled for security
    browser: options.enableBrowser ? {} : {
      enabled: false,
    },

    // Security - maximum security settings
    security: {
      sandbox: {
        enabled: true,
        strict: true,
      },
      rateLimiting: {
        enabled: true,
        windowMs: 60000, // 1 minute
        maxRequests: 10, // Very restrictive
      },
      ipAllowlist: options.adminAllowedIPs || ["127.0.0.1", "::1"],
    },

    // Memory - minimal settings
    memory: {
      enabled: false, // Disable persistent memory for safety
    },

    // UI - minimal interface for recovery
    ui: {
      enabled: true,
      safeMode: true, // Special safe mode UI flag
      theme: "minimal",
      showAdvanced: false, // Hide advanced options
    },
  };

  return safeConfig;
}

/**
 * Generate a secure random token for safe mode access
 */
function generateSecureToken(): string {
  const crypto = require("crypto");
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Validate that a config is suitable for safe mode
 */
export function validateSafeModeConfig(config: OpenClawConfig): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check that gateway is localhost only
  if (config.gateway?.host && config.gateway.host !== "127.0.0.1" && config.gateway.host !== "localhost") {
    issues.push("Safe mode gateway must bind to localhost only");
  }

  // Check that auth is enabled
  if (!config.gateway?.auth?.token && !config.gateway?.auth?.password) {
    issues.push("Safe mode requires authentication");
  }

  // Check that external channels are limited
  if (config.channels) {
    const externalChannels = ["discord", "slack", "telegram", "whatsapp", "signal"];
    for (const channel of externalChannels) {
      if ((config.channels as any)[channel]?.enabled) {
        issues.push(`External channel ${channel} should be disabled in safe mode`);
      }
    }
  }

  // Check that plugins are disabled or minimal
  if (config.plugins && typeof config.plugins === "object" && config.plugins.enabled !== false) {
    issues.push("Plugins should be disabled in safe mode for security");
  }

  // Check that tool security is strict
  if (config.tools?.security !== "allowlist") {
    issues.push("Tool security must use allowlist mode in safe mode");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Apply safe mode restrictions to an existing config
 */
export function applySafeModeRestrictions(config: OpenClawConfig, options: SafeModeOptions = {}): OpenClawConfig {
  const safeConfig = { ...config };

  // Override gateway settings
  if (safeConfig.gateway) {
    safeConfig.gateway = {
      ...safeConfig.gateway,
      host: "127.0.0.1",
      auth: {
        ...safeConfig.gateway.auth,
        mode: "token",
        token: options.adminPassword || safeConfig.gateway.auth?.token || generateSecureToken(),
      },
      remote: { enabled: false },
      cors: { enabled: false },
    };
  }

  // Disable external channels unless explicitly enabled
  if (!options.enableChannels && safeConfig.channels) {
    const externalChannels = ["discord", "slack", "telegram", "whatsapp", "signal"];
    for (const channel of externalChannels) {
      if ((safeConfig.channels as any)[channel]) {
        (safeConfig.channels as any)[channel] = { enabled: false };
      }
    }
  }

  // Disable plugins unless explicitly enabled
  if (!options.enablePlugins) {
    safeConfig.plugins = { enabled: false, autoEnable: false };
  }

  // Disable cron unless explicitly enabled
  if (!options.enableCron) {
    safeConfig.cron = { enabled: false };
  }

  // Disable browser unless explicitly enabled
  if (!options.enableBrowser) {
    safeConfig.browser = { enabled: false };
  }

  // Apply strict tool security
  if (safeConfig.tools) {
    safeConfig.tools.security = "allowlist";
    safeConfig.tools.allowlist = safeConfig.tools.allowlist || [
      "read", "write", "exec", "config.*"
    ];
  }

  // Mark as safe mode in UI
  if (safeConfig.ui) {
    safeConfig.ui.safeMode = true;
  }

  return safeConfig;
}

/**
 * Check if the current process should start in safe mode
 * This checks for:
 * 1. OPENCLAW_SAFE_MODE environment variable
 * 2. Presence of safe mode sentinel file
 * 3. Recent startup failures (crash detection)
 */
export function shouldStartInSafeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  // Check explicit safe mode flag
  if (isSafeModeEnabled(env)) {
    return true;
  }

  // Check for safe mode sentinel file
  const sentinelPath = getSafeModeSentinelPath(env);
  if (require("fs").existsSync(sentinelPath)) {
    return true;
  }

  // TODO: Check for recent crashes/startup failures
  // This could look at restart sentinel files or crash logs

  return false;
}

/**
 * Get the path to the safe mode sentinel file
 */
function getSafeModeSentinelPath(env: NodeJS.ProcessEnv): string {
  const { resolveStateDir } = require("./paths.js");
  const { resolveRequiredHomeDir } = require("../infra/dotenv.js");
  const path = require("path");
  
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, () => require("os").homedir()));
  return path.join(stateDir, "safe-mode.sentinel");
}

/**
 * Create safe mode sentinel file to trigger safe mode on next startup
 */
export async function createSafeModeSentinel(reason?: string): Promise<void> {
  const sentinelPath = getSafeModeSentinelPath();
  const fs = require("fs").promises;
  
  const sentinelData = {
    created: new Date().toISOString(),
    reason: reason || "Manual safe mode activation",
    pid: process.pid,
  };

  await fs.writeFile(sentinelPath, JSON.stringify(sentinelData, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Remove safe mode sentinel file
 */
export async function removeSafeModeSentinel(): Promise<void> {
  const sentinelPath = getSafeModeSentinelPath();
  const fs = require("fs").promises;
  
  try {
    await fs.unlink(sentinelPath);
  } catch (error) {
    // Ignore if file doesn't exist
    if ((error as any)?.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Log safe mode activation
 */
export function logSafeModeActivation(logger: Pick<typeof console, "info" | "warn" | "error"> = console): void {
  logger.warn("🔒 OpenClaw Safe Mode Activated");
  logger.info("Safe mode provides minimal functionality for recovery operations");
  logger.info("External channels, plugins, and advanced features are disabled");
  logger.info("To exit safe mode: fix configuration issues and restart without OPENCLAW_SAFE_MODE");
  logger.info("For emergency recovery, use: openclaw config emergency-recover");
}