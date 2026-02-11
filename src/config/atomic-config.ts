/**
 * Atomic Configuration Management for OpenClaw
 * 
 * Provides atomic config operations with validation, backup, rollback, and health checks.
 * Ensures configuration changes are applied safely with fail-safe defaults.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenClawConfig, ConfigFileSnapshot } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";
import { writeConfigFile as originalWriteConfigFile, readConfigFileSnapshot } from "./io.js";
import { resolveConfigPath, resolveStateDir } from "./paths.js";
import { resolveRequiredHomeDir } from "../infra/dotenv.js";

export type ConfigBackup = {
  id: string;
  timestamp: number;
  hash: string;
  config: OpenClawConfig;
  raw: string;
  notes?: string;
  healthy: boolean;
};

export type AtomicConfigOptions = {
  /** Maximum number of backups to keep */
  maxBackups?: number;
  /** Health check timeout in milliseconds */
  healthCheckTimeoutMs?: number;
  /** Whether to perform health check after apply */
  enableHealthCheck?: boolean;
  /** Custom validation function */
  customValidation?: (config: OpenClawConfig) => Promise<{ valid: boolean; errors: string[] }>;
  /** Temporary directory for atomic operations */
  tempDir?: string;
  /** Logger for operations */
  logger?: Pick<typeof console, "info" | "warn" | "error" | "debug">;
};

export type ConfigValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  twelveFactorIssues: string[];
};

export type AtomicApplyResult = {
  success: boolean;
  backupId?: string;
  validationResult: ConfigValidationResult;
  healthCheckPassed?: boolean;
  rolledBack?: boolean;
  error?: string;
};

const DEFAULT_OPTIONS: Required<AtomicConfigOptions> = {
  maxBackups: 10,
  healthCheckTimeoutMs: 30000,
  enableHealthCheck: true,
  customValidation: async () => ({ valid: true, errors: [] }),
  tempDir: "",
  logger: console,
};

export class AtomicConfigManager {
  private options: Required<AtomicConfigOptions>;
  private configPath: string;
  private backupDir: string;

  constructor(options: AtomicConfigOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.configPath = resolveConfigPath(process.env, resolveStateDir(process.env, () => resolveRequiredHomeDir(process.env, () => require("os").homedir())));
    
    const stateDir = path.dirname(this.configPath);
    this.backupDir = path.join(stateDir, "config-backups");
    
    if (!this.options.tempDir) {
      this.options.tempDir = path.join(stateDir, "config-temp");
    }
    
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.options.tempDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.options.logger.error("Failed to create atomic config directories:", error);
    }
  }

  private generateBackupId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const random = crypto.randomBytes(4).toString("hex");
    return `${timestamp}-${random}`;
  }

  private getBackupPath(backupId: string): string {
    return path.join(this.backupDir, `${backupId}.json`);
  }

  private getBackupMetaPath(backupId: string): string {
    return path.join(this.backupDir, `${backupId}.meta.json`);
  }

  /**
   * Validate config against 12-factor app principles
   */
  private validate12Factor(config: OpenClawConfig): string[] {
    const issues: string[] = [];

    // Factor 3: Config - Check for hardcoded secrets
    if (this.hasHardcodedSecrets(config)) {
      issues.push("Configuration contains hardcoded secrets - use environment variables instead");
    }

    // Factor 4: Backing Services - Check for hardcoded service URLs
    if (this.hasHardcodedServiceUrls(config)) {
      issues.push("Configuration contains hardcoded service URLs - use environment variables");
    }

    // Factor 5: Build, Release, Run - Check for environment-specific config
    if (this.hasEnvironmentSpecificConfig(config)) {
      issues.push("Configuration contains environment-specific values - externalize via env vars");
    }

    // Factor 10: Dev/Prod Parity - Check for development-specific settings
    if (this.hasDevelopmentOnlySettings(config)) {
      issues.push("Configuration contains development-only settings that may not work in production");
    }

    // Factor 11: Logs - Check logging configuration
    if (this.hasImproperLoggingConfig(config)) {
      issues.push("Logging should write to stdout/stderr, not files in cloud-native deployments");
    }

    return issues;
  }

  private hasHardcodedSecrets(config: OpenClawConfig): boolean {
    const configStr = JSON.stringify(config);
    // Look for patterns that might be API keys or tokens
    const secretPatterns = [
      /['"](sk-[a-zA-Z0-9]+)['"]/, // OpenAI API keys
      /['"](xoxb-[a-zA-Z0-9-]+)['"]/, // Slack bot tokens
      /['"](bot[a-zA-Z0-9:_-]+)['"]/, // Discord bot tokens
      /['"](AIza[a-zA-Z0-9_-]+)['"]/, // Google API keys
    ];
    
    return secretPatterns.some(pattern => pattern.test(configStr));
  }

  private hasHardcodedServiceUrls(config: OpenClawConfig): boolean {
    const configStr = JSON.stringify(config);
    // Check for hardcoded URLs that should be configurable
    const urlPatterns = [
      /['"]https?:\/\/[^'"]*\.amazonaws\.com[^'"]*['"]/, // AWS endpoints
      /['"]https?:\/\/[^'"]*\.googleapis\.com[^'"]*['"]/, // Google endpoints
      /['"]https?:\/\/api\.[^'"]*\.com[^'"]*['"]/, // API endpoints
    ];
    
    return urlPatterns.some(pattern => pattern.test(configStr));
  }

  private hasEnvironmentSpecificConfig(config: OpenClawConfig): boolean {
    const configStr = JSON.stringify(config);
    // Check for environment-specific markers
    return /['"](?:dev|development|staging|prod|production)['"]/.test(configStr);
  }

  private hasDevelopmentOnlySettings(config: OpenClawConfig): boolean {
    const debugSettings = [
      config.logging?.level === "debug",
      config.gateway?.auth?.disabled === true,
      config.sandbox?.enabled === false,
    ];
    
    return debugSettings.some(Boolean);
  }

  private hasImproperLoggingConfig(config: OpenClawConfig): boolean {
    // In 12-factor apps, logs should go to stdout/stderr, not files
    const logsToFiles = config.logging?.file !== undefined;
    return logsToFiles;
  }

  /**
   * Comprehensive config validation including 12-factor principles
   */
  async validateConfig(config: OpenClawConfig): Promise<ConfigValidationResult> {
    const result: ConfigValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      twelveFactorIssues: [],
    };

    try {
      // Standard OpenClaw validation
      const validated = validateConfigObjectWithPlugins(config);
      if (!validated.ok) {
        result.valid = false;
        result.errors = validated.issues.map(issue => 
          `${issue.path || 'root'}: ${issue.message}`
        );
      }
      result.warnings = validated.warnings?.map(warning => 
        `${warning.path || 'root'}: ${warning.message}`
      ) || [];

      // 12-factor validation
      result.twelveFactorIssues = this.validate12Factor(config);

      // Custom validation if provided
      const customResult = await this.options.customValidation(config);
      if (!customResult.valid) {
        result.valid = false;
        result.errors.push(...customResult.errors);
      }

    } catch (error) {
      result.valid = false;
      result.errors.push(`Validation failed: ${error}`);
    }

    return result;
  }

  /**
   * Create a backup of the current configuration
   */
  async createBackup(notes?: string): Promise<string> {
    try {
      const snapshot = await readConfigFileSnapshot();
      const backupId = this.generateBackupId();
      
      const backup: ConfigBackup = {
        id: backupId,
        timestamp: Date.now(),
        hash: snapshot.hash || "unknown",
        config: snapshot.config,
        raw: snapshot.raw || JSON.stringify(snapshot.config, null, 2),
        notes,
        healthy: true, // Assume current config is healthy if we can read it
      };

      // Write backup data
      const backupPath = this.getBackupPath(backupId);
      const metaPath = this.getBackupMetaPath(backupId);
      
      await fs.promises.writeFile(backupPath, backup.raw, { encoding: "utf-8", mode: 0o600 });
      await fs.promises.writeFile(metaPath, JSON.stringify(backup, null, 2), { 
        encoding: "utf-8", 
        mode: 0o600 
      });

      this.options.logger.info(`Created config backup: ${backupId}`);
      
      // Cleanup old backups
      await this.cleanupOldBackups();
      
      return backupId;
    } catch (error) {
      this.options.logger.error("Failed to create config backup:", error);
      throw new Error(`Backup creation failed: ${error}`);
    }
  }

  /**
   * List available backups
   */
  async listBackups(): Promise<ConfigBackup[]> {
    try {
      const files = await fs.promises.readdir(this.backupDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));
      
      const backups: ConfigBackup[] = [];
      
      for (const metaFile of metaFiles) {
        try {
          const metaPath = path.join(this.backupDir, metaFile);
          const metaContent = await fs.promises.readFile(metaPath, "utf-8");
          const backup = JSON.parse(metaContent) as ConfigBackup;
          backups.push(backup);
        } catch (error) {
          this.options.logger.warn(`Failed to read backup meta ${metaFile}:`, error);
        }
      }
      
      return backups.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      this.options.logger.error("Failed to list backups:", error);
      return [];
    }
  }

  /**
   * Get the last known healthy backup
   */
  async getLastHealthyBackup(): Promise<ConfigBackup | null> {
    const backups = await this.listBackups();
    return backups.find(backup => backup.healthy) || null;
  }

  /**
   * Rollback to a specific backup
   */
  async rollback(backupId: string): Promise<AtomicApplyResult> {
    try {
      this.options.logger.info(`Rolling back to backup: ${backupId}`);
      
      const metaPath = this.getBackupMetaPath(backupId);
      if (!fs.existsSync(metaPath)) {
        return {
          success: false,
          validationResult: { valid: false, errors: [`Backup ${backupId} not found`], warnings: [], twelveFactorIssues: [] },
          error: `Backup ${backupId} not found`,
        };
      }

      const metaContent = await fs.promises.readFile(metaPath, "utf-8");
      const backup = JSON.parse(metaContent) as ConfigBackup;

      // Validate the backup config before applying
      const validation = await this.validateConfig(backup.config);
      if (!validation.valid) {
        return {
          success: false,
          validationResult: validation,
          error: "Backup config is invalid",
        };
      }

      // Apply the backup config atomically
      return await this.applyConfigAtomic(backup.config, `Rollback to ${backupId}`, false);
    } catch (error) {
      this.options.logger.error(`Rollback to ${backupId} failed:`, error);
      return {
        success: false,
        validationResult: { valid: false, errors: [`Rollback failed: ${error}`], warnings: [], twelveFactorIssues: [] },
        error: String(error),
      };
    }
  }

  /**
   * Health check: verify OpenClaw can start with the current config
   */
  async performHealthCheck(): Promise<boolean> {
    try {
      this.options.logger.debug("Performing config health check...");
      
      // TODO: Implement actual health check by attempting to load config and validate it
      // For now, we'll do basic validation
      const snapshot = await readConfigFileSnapshot();
      const validation = await this.validateConfig(snapshot.config);
      
      if (!validation.valid) {
        this.options.logger.warn("Health check failed due to validation errors:", validation.errors);
        return false;
      }

      this.options.logger.debug("Config health check passed");
      return true;
    } catch (error) {
      this.options.logger.error("Health check failed:", error);
      return false;
    }
  }

  /**
   * Apply configuration changes atomically with validation and optional health check
   */
  async applyConfigAtomic(
    newConfig: OpenClawConfig, 
    notes?: string,
    enableHealthCheck = true
  ): Promise<AtomicApplyResult> {
    const startTime = Date.now();
    let backupId: string | undefined;
    
    try {
      this.options.logger.info("Starting atomic config apply...");
      
      // Step 1: Validate new config
      this.options.logger.debug("Validating new configuration...");
      const validation = await this.validateConfig(newConfig);
      
      if (!validation.valid) {
        this.options.logger.error("Config validation failed:", validation.errors);
        return {
          success: false,
          validationResult: validation,
          error: "Configuration validation failed",
        };
      }

      if (validation.warnings.length > 0) {
        this.options.logger.warn("Config validation warnings:", validation.warnings);
      }

      if (validation.twelveFactorIssues.length > 0) {
        this.options.logger.warn("12-factor app principle violations:", validation.twelveFactorIssues);
      }

      // Step 2: Create backup of current config
      this.options.logger.debug("Creating backup of current configuration...");
      try {
        backupId = await this.createBackup(notes || "Pre-apply backup");
      } catch (error) {
        this.options.logger.warn("Failed to create backup, continuing anyway:", error);
      }

      // Step 3: Apply new config atomically
      this.options.logger.debug("Writing new configuration...");
      await originalWriteConfigFile(newConfig);

      // Step 4: Health check (if enabled)
      let healthCheckPassed = true;
      if (enableHealthCheck && this.options.enableHealthCheck) {
        this.options.logger.debug("Performing post-apply health check...");
        
        // Give the system a moment to stabilize
        await delay(1000);
        
        const healthCheckStart = Date.now();
        const timeoutPromise = delay(this.options.healthCheckTimeoutMs).then(() => false);
        const healthCheckPromise = this.performHealthCheck();
        
        healthCheckPassed = await Promise.race([healthCheckPromise, timeoutPromise]);
        
        if (!healthCheckPassed) {
          this.options.logger.error(`Health check failed after ${Date.now() - healthCheckStart}ms`);
          
          // Auto-rollback if we have a backup
          if (backupId) {
            this.options.logger.info("Initiating automatic rollback...");
            const rollbackResult = await this.rollback(backupId);
            
            return {
              success: false,
              backupId,
              validationResult: validation,
              healthCheckPassed: false,
              rolledBack: rollbackResult.success,
              error: `Health check failed, ${rollbackResult.success ? 'rolled back successfully' : 'rollback also failed'}`,
            };
          } else {
            return {
              success: false,
              validationResult: validation,
              healthCheckPassed: false,
              error: "Health check failed and no backup available for rollback",
            };
          }
        }
      }

      // Mark backup as healthy if health check passed
      if (backupId && healthCheckPassed) {
        await this.markBackupHealthy(backupId);
      }

      const duration = Date.now() - startTime;
      this.options.logger.info(`Atomic config apply completed successfully in ${duration}ms`);
      
      return {
        success: true,
        backupId,
        validationResult: validation,
        healthCheckPassed,
        rolledBack: false,
      };

    } catch (error) {
      this.options.logger.error("Atomic config apply failed:", error);
      
      // Attempt rollback if we created a backup
      if (backupId) {
        this.options.logger.info("Attempting rollback due to apply failure...");
        const rollbackResult = await this.rollback(backupId);
        
        return {
          success: false,
          backupId,
          validationResult: { valid: false, errors: [String(error)], warnings: [], twelveFactorIssues: [] },
          rolledBack: rollbackResult.success,
          error: `Apply failed: ${error}${rollbackResult.success ? ', rolled back successfully' : ', rollback also failed'}`,
        };
      }
      
      return {
        success: false,
        validationResult: { valid: false, errors: [String(error)], warnings: [], twelveFactorIssues: [] },
        error: String(error),
      };
    }
  }

  private async markBackupHealthy(backupId: string): Promise<void> {
    try {
      const metaPath = this.getBackupMetaPath(backupId);
      const metaContent = await fs.promises.readFile(metaPath, "utf-8");
      const backup = JSON.parse(metaContent) as ConfigBackup;
      
      backup.healthy = true;
      
      await fs.promises.writeFile(metaPath, JSON.stringify(backup, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (error) {
      this.options.logger.warn(`Failed to mark backup ${backupId} as healthy:`, error);
    }
  }

  private async cleanupOldBackups(): Promise<void> {
    try {
      const backups = await this.listBackups();
      
      if (backups.length > this.options.maxBackups) {
        const toDelete = backups.slice(this.options.maxBackups);
        
        for (const backup of toDelete) {
          try {
            await fs.promises.unlink(this.getBackupPath(backup.id));
            await fs.promises.unlink(this.getBackupMetaPath(backup.id));
            this.options.logger.debug(`Cleaned up old backup: ${backup.id}`);
          } catch (error) {
            this.options.logger.warn(`Failed to cleanup backup ${backup.id}:`, error);
          }
        }
      }
    } catch (error) {
      this.options.logger.warn("Failed to cleanup old backups:", error);
    }
  }

  /**
   * Emergency recovery: rollback to the last known healthy configuration
   */
  async emergencyRecover(): Promise<AtomicApplyResult> {
    this.options.logger.info("Initiating emergency recovery...");
    
    const lastHealthy = await this.getLastHealthyBackup();
    
    if (!lastHealthy) {
      return {
        success: false,
        validationResult: { valid: false, errors: ["No healthy backup available for recovery"], warnings: [], twelveFactorIssues: [] },
        error: "No healthy backup available for recovery",
      };
    }

    this.options.logger.info(`Emergency recovery using backup: ${lastHealthy.id}`);
    return await this.rollback(lastHealthy.id);
  }
}

/**
 * Global instance of the atomic config manager
 */
let globalAtomicConfigManager: AtomicConfigManager | null = null;

export function getAtomicConfigManager(options?: AtomicConfigOptions): AtomicConfigManager {
  if (!globalAtomicConfigManager) {
    globalAtomicConfigManager = new AtomicConfigManager(options);
  }
  return globalAtomicConfigManager;
}

/**
 * Convenience function for atomic config apply
 */
export async function applyConfigAtomic(
  config: OpenClawConfig,
  notes?: string,
  options?: AtomicConfigOptions
): Promise<AtomicApplyResult> {
  const manager = getAtomicConfigManager(options);
  return await manager.applyConfigAtomic(config, notes);
}

/**
 * Convenience function for emergency recovery
 */
export async function emergencyRecoverConfig(options?: AtomicConfigOptions): Promise<AtomicApplyResult> {
  const manager = getAtomicConfigManager(options);
  return await manager.emergencyRecover();
}