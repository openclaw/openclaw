/**
 * CLI commands for atomic configuration management
 */

import type { Command } from "commander";
import { readConfigFileSnapshot } from "../config/config.js";
import { 
  getAtomicConfigManager, 
  applyConfigAtomic,
  emergencyRecoverConfig,
  type AtomicConfigOptions,
  type ConfigBackup 
} from "../config/atomic-config.js";
import { 
  createSafeModeConfig,
  createSafeModeSentinel,
  removeSafeModeSentinel,
  isSafeModeEnabled,
  shouldStartInSafeMode,
  applySafeModeRestrictions,
  validateSafeModeConfig 
} from "../config/safe-mode.js";
import { theme } from "../terminal/theme.js";
import { success, warn, danger } from "../globals.js";

export function addConfigAtomicCommands(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Atomic configuration management");

  // Backup commands
  configCmd
    .command("backup")
    .description("Create a backup of the current configuration")
    .option("-n, --notes <notes>", "Notes for this backup")
    .action(async (options) => {
      try {
        const manager = getAtomicConfigManager();
        const backupId = await manager.createBackup(options.notes);
        
        console.log(success(`✓ Configuration backup created: ${backupId}`));
        if (options.notes) {
          console.log(theme.muted(`  Notes: ${options.notes}`));
        }
      } catch (error) {
        console.error(danger(`✗ Backup failed: ${error}`));
        process.exit(1);
      }
    });

  // List backups
  configCmd
    .command("backups")
    .description("List available configuration backups")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const manager = getAtomicConfigManager();
        const backups = await manager.listBackups();
        
        if (options.json) {
          console.log(JSON.stringify(backups, null, 2));
          return;
        }

        if (backups.length === 0) {
          console.log(warn("No backups found"));
          return;
        }

        console.log(theme.heading("Configuration Backups:"));
        console.log("");
        
        for (const backup of backups) {
          const date = new Date(backup.timestamp).toLocaleString();
          const healthIcon = backup.healthy ? success("✓") : danger("✗");
          const notesText = backup.notes ? theme.muted(` - ${backup.notes}`) : "";
          
          console.log(`${healthIcon} ${backup.id} ${theme.muted(`(${date})`)}${notesText}`);
        }
      } catch (error) {
        console.error(danger(`✗ Failed to list backups: ${error}`));
        process.exit(1);
      }
    });

  // Rollback command
  configCmd
    .command("rollback <backup-id>")
    .description("Rollback to a specific configuration backup")
    .option("--no-health-check", "Skip health check after rollback")
    .action(async (backupId, options) => {
      try {
        console.log(warn(`Rolling back to backup: ${backupId}...`));
        
        const manager = getAtomicConfigManager({
          enableHealthCheck: options.healthCheck !== false,
        });
        
        const result = await manager.rollback(backupId);
        
        if (result.success) {
          console.log(success(`✓ Successfully rolled back to ${backupId}`));
          if (result.healthCheckPassed === false) {
            console.log(warn("⚠ Health check failed but rollback completed"));
          }
        } else {
          console.error(danger(`✗ Rollback failed: ${result.error}`));
          if (result.validationResult.errors.length > 0) {
            console.log(danger("Validation errors:"));
            result.validationResult.errors.forEach(error => 
              console.log(danger(`  - ${error}`))
            );
          }
          process.exit(1);
        }
      } catch (error) {
        console.error(danger(`✗ Rollback failed: ${error}`));
        process.exit(1);
      }
    });

  // Emergency recovery
  configCmd
    .command("emergency-recover")
    .description("Emergency recovery using the last known healthy backup")
    .action(async () => {
      try {
        console.log(warn("🚨 Initiating emergency recovery..."));
        
        const result = await emergencyRecoverConfig();
        
        if (result.success) {
          console.log(success("✓ Emergency recovery completed successfully"));
          if (result.backupId) {
            console.log(theme.muted(`  Restored from backup: ${result.backupId}`));
          }
        } else {
          console.error(danger(`✗ Emergency recovery failed: ${result.error}`));
          console.log(warn("Consider using safe mode: openclaw config safe-mode --enable"));
          process.exit(1);
        }
      } catch (error) {
        console.error(danger(`✗ Emergency recovery failed: ${error}`));
        process.exit(1);
      }
    });

  // Validate current config
  configCmd
    .command("validate")
    .description("Validate the current configuration")
    .option("--12-factor", "Include 12-factor app validation")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const manager = getAtomicConfigManager();
        const snapshot = await readConfigFileSnapshot();
        const validation = await manager.validateConfig(snapshot.config);
        
        if (options.json) {
          console.log(JSON.stringify(validation, null, 2));
          return;
        }

        if (validation.valid) {
          console.log(success("✓ Configuration is valid"));
        } else {
          console.log(danger("✗ Configuration validation failed"));
          console.log("");
          console.log(danger("Errors:"));
          validation.errors.forEach(error => 
            console.log(danger(`  - ${error}`))
          );
        }

        if (validation.warnings.length > 0) {
          console.log("");
          console.log(warn("Warnings:"));
          validation.warnings.forEach(warning => 
            console.log(warn(`  - ${warning}`))
          );
        }

        if (options.twelveFactor && validation.twelveFactorIssues.length > 0) {
          console.log("");
          console.log(theme.info("12-Factor App Issues:"));
          validation.twelveFactorIssues.forEach(issue => 
            console.log(theme.info(`  - ${issue}`))
          );
        }

        if (!validation.valid) {
          process.exit(1);
        }
      } catch (error) {
        console.error(danger(`✗ Validation failed: ${error}`));
        process.exit(1);
      }
    });

  // Apply config atomically
  configCmd
    .command("apply <config-file>")
    .description("Apply configuration atomically with validation and backup")
    .option("-n, --notes <notes>", "Notes for the backup")
    .option("--no-backup", "Skip creating backup")
    .option("--no-health-check", "Skip health check after apply")
    .option("--timeout <ms>", "Health check timeout in milliseconds", "30000")
    .action(async (configFile, options) => {
      try {
        const fs = require("fs");
        const JSON5 = require("json5");
        
        if (!fs.existsSync(configFile)) {
          console.error(danger(`✗ Config file not found: ${configFile}`));
          process.exit(1);
        }

        console.log(warn(`Applying configuration from: ${configFile}`));
        
        // Read and parse config file
        const configContent = fs.readFileSync(configFile, "utf-8");
        let newConfig;
        try {
          newConfig = JSON5.parse(configContent);
        } catch (error) {
          console.error(danger(`✗ Failed to parse config file: ${error}`));
          process.exit(1);
        }

        // Apply atomically
        const atomicOptions: AtomicConfigOptions = {
          enableHealthCheck: options.healthCheck !== false,
          healthCheckTimeoutMs: parseInt(options.timeout, 10),
        };

        const result = await applyConfigAtomic(newConfig, options.notes, atomicOptions);
        
        if (result.success) {
          console.log(success("✓ Configuration applied successfully"));
          if (result.backupId) {
            console.log(theme.muted(`  Backup created: ${result.backupId}`));
          }
          if (result.healthCheckPassed === true) {
            console.log(success("  Health check passed"));
          }
        } else {
          console.error(danger(`✗ Configuration apply failed: ${result.error}`));
          
          if (result.rolledBack) {
            console.log(warn("  Automatically rolled back to previous configuration"));
          }
          
          if (result.validationResult.errors.length > 0) {
            console.log(danger("Validation errors:"));
            result.validationResult.errors.forEach(error => 
              console.log(danger(`  - ${error}`))
            );
          }
          
          process.exit(1);
        }
      } catch (error) {
        console.error(danger(`✗ Apply failed: ${error}`));
        process.exit(1);
      }
    });

  // Safe mode commands
  const safeModeCmd = configCmd
    .command("safe-mode")
    .description("Safe mode configuration management");

  safeModeCmd
    .command("enable")
    .description("Enable safe mode on next startup")
    .option("-r, --reason <reason>", "Reason for enabling safe mode")
    .action(async (options) => {
      try {
        await createSafeModeSentinel(options.reason);
        console.log(warn("🔒 Safe mode will be activated on next startup"));
        if (options.reason) {
          console.log(theme.muted(`   Reason: ${options.reason}`));
        }
        console.log(theme.muted("   To disable: openclaw config safe-mode disable"));
      } catch (error) {
        console.error(danger(`✗ Failed to enable safe mode: ${error}`));
        process.exit(1);
      }
    });

  safeModeCmd
    .command("disable")
    .description("Disable safe mode")
    .action(async () => {
      try {
        await removeSafeModeSentinel();
        console.log(success("✓ Safe mode disabled"));
        console.log(theme.muted("   Restart OpenClaw to apply changes"));
      } catch (error) {
        console.error(danger(`✗ Failed to disable safe mode: ${error}`));
        process.exit(1);
      }
    });

  safeModeCmd
    .command("status")
    .description("Check safe mode status")
    .action(() => {
      const envEnabled = isSafeModeEnabled();
      const shouldStart = shouldStartInSafeMode();
      
      if (envEnabled) {
        console.log(warn("🔒 Safe mode is ENABLED via environment variable"));
      } else if (shouldStart) {
        console.log(warn("🔒 Safe mode is ENABLED via sentinel file"));
      } else {
        console.log(success("✓ Safe mode is DISABLED"));
      }
    });

  safeModeCmd
    .command("generate")
    .description("Generate a safe mode configuration")
    .option("-o, --output <file>", "Output file (default: stdout)")
    .option("--enable-channels", "Enable channels in safe mode")
    .option("--enable-agents", "Enable custom agents")
    .option("--enable-plugins", "Enable plugins")
    .option("--enable-cron", "Enable cron jobs")
    .option("--enable-browser", "Enable browser control")
    .action(async (options) => {
      try {
        const safeModeConfig = createSafeModeConfig({
          enableChannels: options.enableChannels,
          enableCustomAgents: options.enableAgents,
          enablePlugins: options.enablePlugins,
          enableCron: options.enableCron,
          enableBrowser: options.enableBrowser,
        });

        const configJson = JSON.stringify(safeModeConfig, null, 2);

        if (options.output) {
          const fs = require("fs");
          fs.writeFileSync(options.output, configJson, "utf-8");
          console.log(success(`✓ Safe mode configuration written to: ${options.output}`));
        } else {
          console.log(configJson);
        }
      } catch (error) {
        console.error(danger(`✗ Failed to generate safe mode config: ${error}`));
        process.exit(1);
      }
    });

  safeModeCmd
    .command("apply-restrictions")
    .description("Apply safe mode restrictions to current config")
    .option("--output <file>", "Output file (default: stdout)")
    .action(async (options) => {
      try {
        const snapshot = await readConfigFileSnapshot();
        const restrictedConfig = applySafeModeRestrictions(snapshot.config);
        
        const validation = validateSafeModeConfig(restrictedConfig);
        if (!validation.valid) {
          console.log(warn("Validation issues with restricted config:"));
          validation.issues.forEach(issue => 
            console.log(warn(`  - ${issue}`))
          );
        }

        const configJson = JSON.stringify(restrictedConfig, null, 2);

        if (options.output) {
          const fs = require("fs");
          fs.writeFileSync(options.output, configJson, "utf-8");
          console.log(success(`✓ Restricted configuration written to: ${options.output}`));
        } else {
          console.log(configJson);
        }
      } catch (error) {
        console.error(danger(`✗ Failed to apply restrictions: ${error}`));
        process.exit(1);
      }
    });

  // Health check command
  configCmd
    .command("health-check")
    .description("Perform a configuration health check")
    .option("--timeout <ms>", "Health check timeout in milliseconds", "30000")
    .action(async (options) => {
      try {
        console.log(warn("Performing configuration health check..."));
        
        const manager = getAtomicConfigManager({
          healthCheckTimeoutMs: parseInt(options.timeout, 10),
        });
        
        const healthy = await manager.performHealthCheck();
        
        if (healthy) {
          console.log(success("✓ Configuration health check passed"));
        } else {
          console.log(danger("✗ Configuration health check failed"));
          process.exit(1);
        }
      } catch (error) {
        console.error(danger(`✗ Health check failed: ${error}`));
        process.exit(1);
      }
    });
}