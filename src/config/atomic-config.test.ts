/**
 * Tests for atomic configuration management
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AtomicConfigManager, type AtomicConfigOptions } from "./atomic-config.js";
import type { OpenClawConfig } from "./types.js";

// Mock dependencies
vi.mock("./io.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("./validation.js", () => ({
  validateConfigObjectWithPlugins: vi.fn(),
}));

describe("AtomicConfigManager", () => {
  let tempDir: string;
  let manager: AtomicConfigManager;
  let mockConfig: OpenClawConfig;

  beforeEach(async () => {
    // Create temporary directory for tests
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-atomic-test-"));
    
    const options: AtomicConfigOptions = {
      tempDir: path.join(tempDir, "temp"),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      enableHealthCheck: false, // Disable for most tests
      maxBackups: 5,
    };

    manager = new AtomicConfigManager(options);

    mockConfig = {
      meta: {
        version: "1.0.0",
        lastTouchedAt: new Date().toISOString(),
      },
      gateway: {
        host: "127.0.0.1",
        port: 8080,
        auth: {
          mode: "token",
          token: "test-token",
        },
      },
      agents: {
        defaults: {
          model: "gpt-3.5-turbo",
        },
      },
    };

    // Setup mocks
    const { readConfigFileSnapshot } = await import("./io.js");
    const { validateConfigObjectWithPlugins } = await import("./validation.js");

    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      path: "/test/config.json",
      exists: true,
      raw: JSON.stringify(mockConfig),
      parsed: mockConfig,
      valid: true,
      config: mockConfig,
      hash: "test-hash",
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
      ok: true,
      config: mockConfig,
      issues: [],
      warnings: [],
    });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("12-factor validation", () => {
    it("should detect hardcoded secrets", async () => {
      const configWithSecrets = {
        ...mockConfig,
        providers: {
          openai: {
            apiKey: "sk-hardcodedkey123", // Hardcoded OpenAI key
          },
        },
      };

      const result = await manager.validateConfig(configWithSecrets);

      expect(result.twelveFactorIssues).toContain(
        expect.stringMatching(/hardcoded secrets/i)
      );
    });

    it("should detect hardcoded service URLs", async () => {
      const configWithUrls = {
        ...mockConfig,
        services: {
          database: {
            url: "https://prod.amazonaws.com/db", // Hardcoded AWS URL
          },
        },
      };

      const result = await manager.validateConfig(configWithUrls);

      expect(result.twelveFactorIssues).toContain(
        expect.stringMatching(/hardcoded service URLs/i)
      );
    });

    it("should detect environment-specific config", async () => {
      const configWithEnv = {
        ...mockConfig,
        environment: "production", // Environment-specific value
      };

      const result = await manager.validateConfig(configWithEnv);

      expect(result.twelveFactorIssues).toContain(
        expect.stringMatching(/environment-specific/i)
      );
    });

    it("should detect development-only settings", async () => {
      const devConfig = {
        ...mockConfig,
        logging: { level: "debug" },
        gateway: {
          ...mockConfig.gateway,
          auth: { disabled: true },
        },
      };

      const result = await manager.validateConfig(devConfig);

      expect(result.twelveFactorIssues).toContain(
        expect.stringMatching(/development-only settings/i)
      );
    });

    it("should detect improper logging config", async () => {
      const logConfig = {
        ...mockConfig,
        logging: {
          level: "info",
          file: "/var/log/openclaw.log", // File logging instead of stdout/stderr
        },
      };

      const result = await manager.validateConfig(logConfig);

      expect(result.twelveFactorIssues).toContain(
        expect.stringMatching(/logs should.*stdout/i)
      );
    });
  });

  describe("backup management", () => {
    it("should create backups successfully", async () => {
      const backupId = await manager.createBackup("Test backup");

      expect(backupId).toBeTruthy();
      expect(backupId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/);
    });

    it("should list backups in reverse chronological order", async () => {
      // Create multiple backups
      const backup1 = await manager.createBackup("First backup");
      await new Promise(resolve => setTimeout(resolve, 10)); // Ensure different timestamps
      const backup2 = await manager.createBackup("Second backup");
      await new Promise(resolve => setTimeout(resolve, 10));
      const backup3 = await manager.createBackup("Third backup");

      const backups = await manager.listBackups();

      expect(backups).toHaveLength(3);
      expect(backups[0].id).toBe(backup3); // Most recent first
      expect(backups[1].id).toBe(backup2);
      expect(backups[2].id).toBe(backup1);
    });

    it("should clean up old backups when limit exceeded", async () => {
      // Create more backups than the limit (5)
      const backupIds = [];
      for (let i = 0; i < 7; i++) {
        const id = await manager.createBackup(`Backup ${i}`);
        backupIds.push(id);
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const backups = await manager.listBackups();

      expect(backups).toHaveLength(5); // Should be limited to maxBackups
      
      // Should keep the 5 most recent
      const recentIds = backupIds.slice(-5);
      const backupIdsFromList = backups.map(b => b.id);
      
      for (const recentId of recentIds) {
        expect(backupIdsFromList).toContain(recentId);
      }
    });

    it("should find last healthy backup", async () => {
      await manager.createBackup("Healthy backup 1");
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const unhealthyBackupId = await manager.createBackup("Unhealthy backup");
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const healthyBackupId = await manager.createBackup("Healthy backup 2");

      // Mark one as unhealthy by manually editing the meta file
      const backups = await manager.listBackups();
      const unhealthyBackup = backups.find(b => b.id === unhealthyBackupId);
      if (unhealthyBackup) {
        unhealthyBackup.healthy = false;
        const metaPath = path.join(tempDir, "config-backups", `${unhealthyBackupId}.meta.json`);
        if (fs.existsSync(metaPath)) {
          await fs.promises.writeFile(metaPath, JSON.stringify(unhealthyBackup, null, 2));
        }
      }

      const lastHealthy = await manager.getLastHealthyBackup();

      expect(lastHealthy).toBeTruthy();
      expect(lastHealthy?.id).toBe(healthyBackupId);
    });
  });

  describe("config validation", () => {
    it("should validate valid config successfully", async () => {
      const result = await manager.validateConfig(mockConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should report validation errors", async () => {
      const { validateConfigObjectWithPlugins } = await import("./validation.js");
      
      vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
        ok: false,
        config: mockConfig,
        issues: [
          { path: "gateway.port", message: "Port must be a number" },
          { path: "agents", message: "Agents configuration is invalid" },
        ],
        warnings: [
          { path: "logging", message: "Deprecated logging option" },
        ],
      });

      const result = await manager.validateConfig(mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("gateway.port: Port must be a number");
      expect(result.errors).toContain("agents: Agents configuration is invalid");
      expect(result.warnings).toContain("logging: Deprecated logging option");
    });

    it("should handle validation exceptions", async () => {
      const { validateConfigObjectWithPlugins } = await import("./validation.js");
      
      vi.mocked(validateConfigObjectWithPlugins).mockImplementation(() => {
        throw new Error("Validation crashed");
      });

      const result = await manager.validateConfig(mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Validation failed: Error: Validation crashed");
    });
  });

  describe("atomic apply", () => {
    it("should apply valid config successfully", async () => {
      const { writeConfigFile } = await import("./io.js");

      const result = await manager.applyConfigAtomic(mockConfig, "Test apply");

      expect(result.success).toBe(true);
      expect(result.backupId).toBeTruthy();
      expect(result.validationResult.valid).toBe(true);
      expect(vi.mocked(writeConfigFile)).toHaveBeenCalledWith(mockConfig);
    });

    it("should not apply invalid config", async () => {
      const { validateConfigObjectWithPlugins } = await import("./validation.js");
      const { writeConfigFile } = await import("./io.js");

      vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
        ok: false,
        config: mockConfig,
        issues: [{ path: "test", message: "Test error" }],
        warnings: [],
      });

      const result = await manager.applyConfigAtomic(mockConfig, "Invalid config test");

      expect(result.success).toBe(false);
      expect(result.validationResult.valid).toBe(false);
      expect(result.error).toContain("Configuration validation failed");
      expect(vi.mocked(writeConfigFile)).not.toHaveBeenCalled();
    });

    it("should rollback on apply failure", async () => {
      const { writeConfigFile } = await import("./io.js");

      // Mock writeConfigFile to fail
      vi.mocked(writeConfigFile).mockRejectedValue(new Error("Write failed"));

      // First create a backup to rollback to
      const backupId = await manager.createBackup("Pre-test backup");

      const result = await manager.applyConfigAtomic(mockConfig, "Failing apply test");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toContain("Write failed");
    });
  });

  describe("rollback", () => {
    it("should rollback to existing backup", async () => {
      const backupId = await manager.createBackup("Rollback test backup");

      const result = await manager.rollback(backupId);

      expect(result.success).toBe(true);
      expect(result.validationResult.valid).toBe(true);
    });

    it("should fail rollback to non-existent backup", async () => {
      const result = await manager.rollback("non-existent-backup-id");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should not rollback to invalid backup", async () => {
      const { validateConfigObjectWithPlugins } = await import("./validation.js");

      // Create a backup first
      const backupId = await manager.createBackup("Invalid backup test");

      // Then make validation fail for the backup
      vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
        ok: false,
        config: mockConfig,
        issues: [{ path: "test", message: "Backup is invalid" }],
        warnings: [],
      });

      const result = await manager.rollback(backupId);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup config is invalid");
    });
  });

  describe("emergency recovery", () => {
    it("should recover using last healthy backup", async () => {
      // Create a healthy backup
      const backupId = await manager.createBackup("Emergency recovery test");

      const result = await manager.emergencyRecover();

      expect(result.success).toBe(true);
      expect(result.validationResult.valid).toBe(true);
    });

    it("should fail if no healthy backup exists", async () => {
      // Don't create any backups
      const result = await manager.emergencyRecover();

      expect(result.success).toBe(false);
      expect(result.error).toContain("No healthy backup available");
    });
  });

  describe("health check", () => {
    it("should pass health check for valid config", async () => {
      const result = await manager.performHealthCheck();

      expect(result).toBe(true);
    });

    it("should fail health check for invalid config", async () => {
      const { validateConfigObjectWithPlugins } = await import("./validation.js");

      vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
        ok: false,
        config: mockConfig,
        issues: [{ path: "test", message: "Health check failure" }],
        warnings: [],
      });

      const result = await manager.performHealthCheck();

      expect(result).toBe(false);
    });

    it("should handle health check exceptions", async () => {
      const { readConfigFileSnapshot } = await import("./io.js");

      vi.mocked(readConfigFileSnapshot).mockRejectedValue(new Error("Health check crashed"));

      const result = await manager.performHealthCheck();

      expect(result).toBe(false);
    });
  });
});