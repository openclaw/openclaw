/**
 * Configuration Loader
 *
 * Loads and validates LLM extraction configurations with caching for performance.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMConfig } from "./types.js";
import { ExtractionError, ExtractionErrorCode } from "./types.js";
import { getChildLogger } from "../../logging/logger.js";

const logger = getChildLogger({ module: "config-loader" });

// Get directory name for ESM modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Configuration loader with validation and caching
 */
export class ConfigLoader {
  private static readonly configCache = new Map<string, LLMConfig>();
  private static readonly configDir = resolve(__dirname, "../../../config/llm-extraction");

  /**
   * Load configuration for a specific LLM type
   *
   * @param llmType - The LLM type identifier (e.g., 'claude-code', 'codex')
   * @returns The validated configuration
   * @throws ExtractionError if config not found or invalid
   */
  static load(llmType: string): LLMConfig {
    // Check cache first
    const cached = this.configCache.get(llmType);
    if (cached) {
      return cached;
    }

    // Try to load from file
    const configPath = resolve(this.configDir, `${llmType}.json`);

    let config: LLMConfig;
    try {
      const raw = readFileSync(configPath, "utf-8");
      config = JSON.parse(raw) as LLMConfig;

      logger.debug("config_loaded", {
        llmType,
        configPath,
        configSize: raw.length,
      });
    } catch (error) {
      // If specific config not found, try default
      if (llmType !== "default") {
        logger.warn("config_fallback", {
          requestedLlm: llmType,
          fallbackLlm: "default",
          reason: "config_not_found",
          error: error instanceof Error ? error.message : String(error),
        });
        return this.load("default");
      }

      logger.error("config_load_failed", {
        llmType,
        configPath,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ExtractionError(
        `Configuration not found for LLM type: ${llmType}`,
        ExtractionErrorCode.CONFIG_NOT_FOUND,
        false, // not recoverable
      );
    }

    // Validate configuration
    this.validate(config, llmType);

    // Cache and return
    this.configCache.set(llmType, config);
    return config;
  }

  /**
   * Load all available configurations
   *
   * @returns Map of LLM type to configuration
   */
  static loadAll(): Map<string, LLMConfig> {
    const configs = new Map<string, LLMConfig>();
    const types = ["claude-code", "codex", "default"];

    for (const type of types) {
      try {
        configs.set(type, this.load(type));
      } catch (error) {
        logger.warn("config_load_all_failed", {
          llmType: type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("config_load_all_complete", {
      loadedCount: configs.size,
      attemptedCount: types.length,
    });

    return configs;
  }

  /**
   * Clear the configuration cache (useful for testing)
   */
  static clearCache(): void {
    this.configCache.clear();
  }

  /**
   * Validate a configuration object
   *
   * @param config - The configuration to validate
   * @param llmType - The LLM type for error messages
   * @throws ExtractionError if validation fails
   */
  private static validate(config: LLMConfig, llmType: string): void {
    const errors: string[] = [];

    // Required fields
    if (!config.name) {
      errors.push("name is required");
    }
    if (!config.response_marker) {
      errors.push("response_marker is required");
    }
    if (!config.prompt_marker) {
      errors.push("prompt_marker is required");
    }
    if (!Array.isArray(config.stop_patterns)) {
      errors.push("stop_patterns must be an array");
    }
    if (!Array.isArray(config.noise_patterns)) {
      errors.push("noise_patterns must be an array");
    }

    // Validate schema version if present
    if (config.schema_version !== undefined) {
      if (typeof config.schema_version !== "number" || config.schema_version < 1) {
        errors.push("schema_version must be a positive number");
      }
    } else {
      // Add default schema version
      config.schema_version = 1;
    }

    // Validate patterns
    if (Array.isArray(config.stop_patterns)) {
      config.stop_patterns.forEach((pattern, idx) => {
        const patternErrors = this.validatePattern(pattern, `stop_patterns[${idx}]`);
        errors.push(...patternErrors);
      });
    }

    if (Array.isArray(config.noise_patterns)) {
      config.noise_patterns.forEach((pattern, idx) => {
        const patternErrors = this.validatePattern(pattern, `noise_patterns[${idx}]`);
        errors.push(...patternErrors);
      });
    }

    // Validate echo_pattern if present
    if (config.echo_pattern) {
      try {
        new RegExp(config.echo_pattern);
      } catch {
        errors.push(`echo_pattern is not a valid regex: ${config.echo_pattern}`);
      }
    }

    if (errors.length > 0) {
      throw new ExtractionError(
        `Invalid configuration for ${llmType}: ${errors.join(", ")}`,
        ExtractionErrorCode.INVALID_CONFIG,
        false, // not recoverable
      );
    }
  }

  /**
   * Validate a single noise pattern
   */
  private static validatePattern(pattern: unknown, context: string): string[] {
    const errors: string[] = [];

    if (typeof pattern !== "object" || pattern === null) {
      errors.push(`${context}: must be an object`);
      return errors;
    }

    const p = pattern as Record<string, unknown>;

    // Type is required
    if (!p.type) {
      errors.push(`${context}: type is required`);
    } else if (!["prefix", "regex", "separator", "context_hint"].includes(p.type as string)) {
      errors.push(`${context}: invalid type "${p.type}"`);
    }

    // Validate type-specific fields
    switch (p.type) {
      case "prefix":
        if (!p.value || typeof p.value !== "string") {
          errors.push(`${context}: prefix type requires value (string)`);
        }
        break;
      case "regex":
      case "context_hint":
        if (!p.pattern || typeof p.pattern !== "string") {
          errors.push(`${context}: ${p.type} type requires pattern (string)`);
        } else {
          // Validate regex
          try {
            new RegExp(p.pattern as string);
          } catch {
            errors.push(`${context}: invalid regex pattern "${p.pattern}"`);
          }
        }
        break;
      case "separator":
        // Chars is optional for separator type
        if (p.chars !== undefined && typeof p.chars !== "string") {
          errors.push(`${context}: chars must be a string`);
        }
        break;
    }

    return errors;
  }

  /**
   * Get the configuration directory path (useful for testing)
   */
  static getConfigDir(): string {
    return this.configDir;
  }
}
