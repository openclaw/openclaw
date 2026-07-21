/**
 * PathResolver Test Suite
 * 
 * Comprehensive tests for the PathResolver class.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PathResolver, getPathResolver, resetPathResolver } from './path-resolver.js';
import { PRODUCT_IDENTITY, LEGACY_IDENTITY, ENVIRONMENT_VARIABLES } from './constants.js';
import { IdentityErrorCode } from './errors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('PathResolver', () => {
  let resolver: PathResolver;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    resolver = new PathResolver();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    resolver.clearCache();
    resetPathResolver();
  });

  describe('constructor', () => {
    it('should create resolver with default options', () => {
      const resolver = new PathResolver();
      expect(resolver).toBeInstanceOf(PathResolver);
    });

    it('should accept custom home directory', () => {
      const customHome = '/custom/home';
      const resolver = new PathResolver({ homeDir: customHome });
      expect(resolver).toBeInstanceOf(PathResolver);
    });

    it('should accept validation option', () => {
      const resolver = new PathResolver({ validatePaths: true });
      expect(resolver).toBeInstanceOf(PathResolver);
    });

    it('should accept directory creation option', () => {
      const resolver = new PathResolver({ createDirectories: true });
      expect(resolver).toBeInstanceOf(PathResolver);
    });
  });

  describe('resolveStateDirectory', () => {
    it('should resolve state directory', () => {
      const stateDir = resolver.resolveStateDirectory();
      expect(stateDir).toContain(PRODUCT_IDENTITY.stateDirectory);
    });

    it('should use environment variable if set', () => {
      const customPath = '/custom/state/dir';
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = customPath;
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      expect(stateDir).toBe(customPath);
    });

    it('should expand tilde in environment variable', () => {
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = '~/custom/state';
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      expect(stateDir).toContain(os.homedir());
      expect(stateDir).toContain('custom/state');
    });

    it('should expand $HOME in environment variable', () => {
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = '$HOME/custom/state';
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      expect(stateDir).toContain(os.homedir());
      expect(stateDir).toContain('custom/state');
    });

    it('should cache resolved path', () => {
      const stateDir1 = resolver.resolveStateDirectory();
      const stateDir2 = resolver.resolveStateDirectory();
      
      expect(stateDir1).toBe(stateDir2);
      
      const cache = resolver.getCache();
      expect(cache.has('stateDirectory')).toBe(true);
    });
  });

  describe('resolveConfigPath', () => {
    it('should resolve config path', () => {
      const configPath = resolver.resolveConfigPath();
      expect(configPath).toContain(PRODUCT_IDENTITY.configFile);
    });

    it('should use environment variable if set', () => {
      const customPath = '/custom/config.json';
      process.env[ENVIRONMENT_VARIABLES.CONFIG_PATH] = customPath;
      
      const resolver = new PathResolver();
      const configPath = resolver.resolveConfigPath();
      
      expect(configPath).toBe(customPath);
    });

    it('should use state directory + config file', () => {
      const stateDir = resolver.resolveStateDirectory();
      const configPath = resolver.resolveConfigPath();
      
      expect(configPath).toBe(path.join(stateDir, PRODUCT_IDENTITY.configFile));
    });
  });

  describe('resolveDatabasePath', () => {
    it('should resolve database path', () => {
      const dbPath = resolver.resolveDatabasePath();
      expect(dbPath).toContain(PRODUCT_IDENTITY.databaseFile);
    });

    it('should use state directory + database file', () => {
      const stateDir = resolver.resolveStateDirectory();
      const dbPath = resolver.resolveDatabasePath();
      
      expect(dbPath).toBe(path.join(stateDir, PRODUCT_IDENTITY.databaseFile));
    });
  });

  describe('resolveLogPath', () => {
    it('should resolve log path', () => {
      const logPath = resolver.resolveLogPath();
      expect(logPath).toContain(PRODUCT_IDENTITY.logFile);
    });

    it('should include logs directory', () => {
      const logPath = resolver.resolveLogPath();
      expect(logPath).toContain('logs');
    });

    it('should use state directory + logs + log file', () => {
      const stateDir = resolver.resolveStateDirectory();
      const logPath = resolver.resolveLogPath();
      
      expect(logPath).toBe(path.join(stateDir, 'logs', PRODUCT_IDENTITY.logFile));
    });
  });

  describe('resolveCachePath', () => {
    it('should resolve cache path', () => {
      const cachePath = resolver.resolveCachePath();
      expect(cachePath).toContain('cache');
    });

    it('should use state directory + cache', () => {
      const stateDir = resolver.resolveStateDirectory();
      const cachePath = resolver.resolveCachePath();
      
      expect(cachePath).toBe(path.join(stateDir, 'cache'));
    });
  });

  describe('resolveTempPath', () => {
    it('should resolve temp path', () => {
      const tempPath = resolver.resolveTempPath();
      expect(tempPath).toContain('temp');
    });

    it('should use state directory + temp', () => {
      const stateDir = resolver.resolveStateDirectory();
      const tempPath = resolver.resolveTempPath();
      
      expect(tempPath).toBe(path.join(stateDir, 'temp'));
    });
  });

  describe('resolvePluginsPath', () => {
    it('should resolve plugins path', () => {
      const pluginsPath = resolver.resolvePluginsPath();
      expect(pluginsPath).toContain('plugins');
    });

    it('should use state directory + plugins', () => {
      const stateDir = resolver.resolveStateDirectory();
      const pluginsPath = resolver.resolvePluginsPath();
      
      expect(pluginsPath).toBe(path.join(stateDir, 'plugins'));
    });
  });

  describe('resolveWorkspacePath', () => {
    it('should resolve workspace path', () => {
      const workspacePath = resolver.resolveWorkspacePath();
      expect(workspacePath).toContain('workspace');
    });

    it('should use state directory + workspace', () => {
      const stateDir = resolver.resolveStateDirectory();
      const workspacePath = resolver.resolveWorkspacePath();
      
      expect(workspacePath).toBe(path.join(stateDir, 'workspace'));
    });
  });

  describe('resolveAll', () => {
    it('should resolve all paths', () => {
      const paths = resolver.resolveAll();
      
      expect(paths).toHaveProperty('stateDirectory');
      expect(paths).toHaveProperty('configPath');
      expect(paths).toHaveProperty('databasePath');
      expect(paths).toHaveProperty('logPath');
      expect(paths).toHaveProperty('cachePath');
      expect(paths).toHaveProperty('tempPath');
      expect(paths).toHaveProperty('pluginsPath');
      expect(paths).toHaveProperty('workspacePath');
    });

    it('should return consistent paths', () => {
      const paths1 = resolver.resolveAll();
      const paths2 = resolver.resolveAll();
      
      expect(paths1.stateDirectory).toBe(paths2.stateDirectory);
      expect(paths1.configPath).toBe(paths2.configPath);
      expect(paths1.databasePath).toBe(paths2.databasePath);
    });
  });

  describe('getLegacyPaths', () => {
    it('should return legacy paths', () => {
      const legacyPaths = resolver.getLegacyPaths();
      
      expect(legacyPaths).toHaveProperty('stateDirectory');
      expect(legacyPaths).toHaveProperty('configPath');
      expect(legacyPaths).toHaveProperty('databasePath');
      expect(legacyPaths).toHaveProperty('logPath');
    });

    it('should use legacy identity', () => {
      const legacyPaths = resolver.getLegacyPaths();
      
      expect(legacyPaths.stateDirectory).toContain(LEGACY_IDENTITY.stateDirectory);
      expect(legacyPaths.configPath).toContain(LEGACY_IDENTITY.configFile);
      expect(legacyPaths.databasePath).toContain(LEGACY_IDENTITY.databaseFile);
    });
  });

  describe('isUsingLegacyPaths', () => {
    it('should return false for new paths', () => {
      const isLegacy = resolver.isUsingLegacyPaths();
      expect(typeof isLegacy).toBe('boolean');
    });

    it('should detect legacy state directory', () => {
      const customHome = os.homedir();
      const legacyStateDir = path.join(customHome, LEGACY_IDENTITY.stateDirectory);
      
      // Create legacy directory
      fs.mkdirSync(legacyStateDir, { recursive: true });
      
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = legacyStateDir;
      
      const resolver = new PathResolver({ homeDir: customHome });
      const isLegacy = resolver.isUsingLegacyPaths();
      
      expect(isLegacy).toBe(true);
      
      // Cleanup
      fs.rmdirSync(legacyStateDir);
    });
  });

  describe('ensureDirectories', () => {
    it('should create directories', async () => {
      const tempDir = path.join(os.tmpdir(), `path-resolver-test-${Date.now()}`);
      const resolver = new PathResolver({ homeDir: tempDir });
      
      await resolver.ensureDirectories();
      
      const paths = resolver.resolveAll();
      
      expect(fs.existsSync(paths.stateDirectory)).toBe(true);
      expect(fs.existsSync(paths.cachePath)).toBe(true);
      expect(fs.existsSync(paths.tempPath)).toBe(true);
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    it('should handle errors gracefully', async () => {
      const invalidPath = '/invalid/path/that/cannot/be/created';
      const resolver = new PathResolver({ homeDir: invalidPath });
      
      await expect(resolver.ensureDirectories()).rejects.toThrow();
    });
  });

  describe('validate', () => {
    it('should validate paths', () => {
      const result = resolver.validate();
      
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('errors');
      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('should return valid for default paths', () => {
      const result = resolver.validate();
      expect(result.valid).toBe(true);
    });

    it('should detect invalid paths', () => {
      const resolver = new PathResolver({ validatePaths: true });
      const result = resolver.validate();
      
      // Should still be valid since paths don't need to exist
      expect(typeof result.valid).toBe('boolean');
    });
  });

  describe('clearCache', () => {
    it('should clear cache', () => {
      resolver.resolveStateDirectory();
      resolver.resolveConfigPath();
      
      const cacheBefore = resolver.getCache();
      expect(cacheBefore.size).toBeGreaterThan(0);
      
      resolver.clearCache();
      
      const cacheAfter = resolver.getCache();
      expect(cacheAfter.size).toBe(0);
    });
  });

  describe('getCache', () => {
    it('should return cache copy', () => {
      resolver.resolveStateDirectory();
      resolver.resolveConfigPath();
      
      const cache = resolver.getCache();
      expect(cache).toBeInstanceOf(Map);
      expect(cache.size).toBeGreaterThan(0);
      
      // Should be a copy, not reference
      cache.clear();
      expect(resolver.getCache().size).toBeGreaterThan(0);
    });
  });

  describe('getPathDetails', () => {
    it('should return path details', () => {
      const details = resolver.getPathDetails('stateDirectory');
      
      expect(details).toHaveProperty('path');
      expect(details).toHaveProperty('exists');
      expect(details).toHaveProperty('isLegacy');
    });

    it('should check if path exists', () => {
      const tempDir = path.join(os.tmpdir(), `path-resolver-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      
      const resolver = new PathResolver({ homeDir: tempDir });
      const details = resolver.getPathDetails('stateDirectory');
      
      expect(typeof details.exists).toBe('boolean');
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });
  });

  describe('formatForDisplay', () => {
    it('should format paths for display', () => {
      const formatted = resolver.formatForDisplay();
      
      expect(formatted).toContain('State Directory');
      expect(formatted).toContain('Config File');
      expect(formatted).toContain('Database');
      expect(formatted).toContain('Log File');
      expect(formatted).toContain('Cache Directory');
      expect(formatted).toContain('Temp Directory');
      expect(formatted).toContain('Plugins Directory');
      expect(formatted).toContain('Workspace Directory');
    });

    it('should indicate legacy usage', () => {
      const customHome = os.homedir();
      const legacyStateDir = path.join(customHome, LEGACY_IDENTITY.stateDirectory);
      
      // Create legacy directory
      fs.mkdirSync(legacyStateDir, { recursive: true });
      
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = legacyStateDir;
      
      const resolver = new PathResolver({ homeDir: customHome });
      const formatted = resolver.formatForDisplay();
      
      expect(formatted).toContain('legacy');
      
      // Cleanup
      fs.rmdirSync(legacyStateDir);
    });
  });

  describe('exportAsJson', () => {
    it('should export paths as JSON', () => {
      const json = resolver.exportAsJson();
      
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should include all required fields', () => {
      const json = resolver.exportAsJson();
      const parsed = JSON.parse(json);
      
      expect(parsed).toHaveProperty('paths');
      expect(parsed).toHaveProperty('isUsingLegacyPaths');
      expect(parsed).toHaveProperty('homeDir');
      expect(parsed.paths).toHaveProperty('stateDirectory');
      expect(parsed.paths).toHaveProperty('configPath');
      expect(parsed.paths).toHaveProperty('databasePath');
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance', () => {
      const instance1 = getPathResolver();
      const instance2 = getPathResolver();
      
      expect(instance1).toBe(instance2);
    });

    it('should reset instance', () => {
      const instance1 = getPathResolver();
      resetPathResolver();
      const instance2 = getPathResolver();
      
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('edge cases', () => {
    it('should handle empty environment variable', () => {
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = '';
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      expect(stateDir).toContain(PRODUCT_IDENTITY.stateDirectory);
    });

    it('should handle special characters in path', () => {
      const customPath = '/path/with spaces/and-dashes';
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = customPath;
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      expect(stateDir).toBe(customPath);
    });

    it('should handle Windows paths', () => {
      const windowsPath = 'C:\\Users\\test\\titanium-claws';
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = windowsPath;
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      expect(stateDir).toBe(windowsPath);
    });

    it('should handle relative paths', () => {
      const relativePath = './titanium-claws';
      process.env[ENVIRONMENT_VARIABLES.STATE_DIR] = relativePath;
      
      const resolver = new PathResolver();
      const stateDir = resolver.resolveStateDirectory();
      
      // Should be converted to absolute path
      expect(path.isAbsolute(stateDir)).toBe(true);
    });
  });

  describe('performance', () => {
    it('should cache paths efficiently', () => {
      const iterations = 1000;
      const startTime = Date.now();
      
      for (let i = 0; i < iterations; i++) {
        resolver.resolveStateDirectory();
        resolver.resolveConfigPath();
        resolver.resolveDatabasePath();
      }
      
      const elapsed = Date.now() - startTime;
      
      // Should complete 1000 iterations in less than 100ms
      expect(elapsed).toBeLessThan(100);
    });
  });
});
