/**
 * Titanium Claws Path Resolver
 * 
 * Resolves filesystem paths with backward compatibility support.
 * Provides methods for accessing all path types used throughout the application.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PRODUCT_IDENTITY, LEGACY_IDENTITY, ENVIRONMENT_VARIABLES } from './constants.js';
import type { ResolvedPaths, LegacyPaths } from './types.js';
import {
  IdentityError,
  PathError,
  IdentityErrorCode,
  ERROR_MESSAGES,
} from './errors.js';

/**
 * Path resolver options
 */
export interface PathResolverOptions {
  /**
   * Home directory override (defaults to OS home directory)
   */
  readonly homeDir?: string;
  
  /**
   * Whether to validate paths exist
   */
  readonly validatePaths?: boolean;
  
  /**
   * Whether to create directories if they don't exist
   */
  readonly createDirectories?: boolean;
}

/**
 * Path resolution result
 */
export interface PathResolutionResult {
  readonly path: string;
  readonly exists: boolean;
  readonly isLegacy: boolean;
}

/**
 * PathResolver - Resolves filesystem paths with backward compatibility
 * 
 * This class provides methods for resolving all filesystem paths used by
 * Titanium Claws, including state directories, configuration files,
 * database files, log files, and other application paths.
 * 
 * Features:
 * - Resolves paths with fallback to legacy OpenClaw paths
 * - Supports environment variable overrides
 * - Handles cross-platform path differences
 * - Provides path validation
 * - Supports directory creation
 * - Thread-safe implementation
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class PathResolver {
  private readonly options: Required<PathResolverOptions>;
  private readonly homeDir: string;
  private readonly cache: Map<string, string> = new Map();

  /**
   * Create a new PathResolver instance
   * 
   * @param options - Configuration options
   */
  constructor(options: PathResolverOptions = {}) {
    this.options = {
      homeDir: options.homeDir ?? os.homedir(),
      validatePaths: options.validatePaths ?? false,
      createDirectories: options.createDirectories ?? false,
    };
    
    this.homeDir = this.options.homeDir;
  }

  /**
   * Resolve the state directory path
   * 
   * Resolution order:
   * 1. Environment variable (TITANIUM_CLAWS_STATE_DIR)
   * 2. New path (~/.titanium-claws)
   * 3. Legacy path (~/.openclaw)
   * 
   * @returns Resolved state directory path
   * @throws {PathError} If path resolution fails
   */
  resolveStateDirectory(): string {
    const cacheKey = 'stateDirectory';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check environment variable
    const envPath = process.env[ENVIRONMENT_VARIABLES.STATE_DIR];
    if (envPath) {
      const fullPath = this.expandPath(envPath);
      this.validateAndCache(cacheKey, fullPath);
      return fullPath;
    }

    // Check new path
    const newPath = path.join(this.homeDir, PRODUCT_IDENTITY.stateDirectory);
    if (fs.existsSync(newPath)) {
      this.validateAndCache(cacheKey, newPath);
      return newPath;
    }

    // Fall back to legacy path
    const legacyPath = path.join(this.homeDir, LEGACY_IDENTITY.stateDirectory);
    if (fs.existsSync(legacyPath)) {
      this.validateAndCache(cacheKey, legacyPath);
      return legacyPath;
    }

    // Default to new path (will be created if needed)
    this.validateAndCache(cacheKey, newPath);
    return newPath;
  }

  /**
   * Resolve the configuration file path
   * 
   * @returns Resolved configuration file path
   * @throws {PathError} If path resolution fails
   */
  resolveConfigPath(): string {
    const cacheKey = 'configPath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check environment variable
    const envPath = process.env[ENVIRONMENT_VARIABLES.CONFIG_PATH];
    if (envPath) {
      const fullPath = this.expandPath(envPath);
      this.validateAndCache(cacheKey, fullPath);
      return fullPath;
    }

    // Use state directory + config file name
    const stateDir = this.resolveStateDirectory();
    const configPath = path.join(stateDir, PRODUCT_IDENTITY.configFile);
    
    this.validateAndCache(cacheKey, configPath);
    return configPath;
  }

  /**
   * Resolve the database file path
   * 
   * @returns Resolved database file path
   * @throws {PathError} If path resolution fails
   */
  resolveDatabasePath(): string {
    const cacheKey = 'databasePath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const stateDir = this.resolveStateDirectory();
    const dbPath = path.join(stateDir, PRODUCT_IDENTITY.databaseFile);
    
    this.validateAndCache(cacheKey, dbPath);
    return dbPath;
  }

  /**
   * Resolve the log file path
   * 
   * @returns Resolved log file path
   * @throws {PathError} If path resolution fails
   */
  resolveLogPath(): string {
    const cacheKey = 'logPath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const stateDir = this.resolveStateDirectory();
    const logPath = path.join(stateDir, 'logs', PRODUCT_IDENTITY.logFile);
    
    this.validateAndCache(cacheKey, logPath);
    return logPath;
  }

  /**
   * Resolve the cache directory path
   * 
   * @returns Resolved cache directory path
   * @throws {PathError} If path resolution fails
   */
  resolveCachePath(): string {
    const cacheKey = 'cachePath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const stateDir = this.resolveStateDirectory();
    const cachePath = path.join(stateDir, 'cache');
    
    this.validateAndCache(cacheKey, cachePath);
    return cachePath;
  }

  /**
   * Resolve the temporary directory path
   * 
   * @returns Resolved temporary directory path
   * @throws {PathError} If path resolution fails
   */
  resolveTempPath(): string {
    const cacheKey = 'tempPath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const stateDir = this.resolveStateDirectory();
    const tempPath = path.join(stateDir, 'temp');
    
    this.validateAndCache(cacheKey, tempPath);
    return tempPath;
  }

  /**
   * Resolve the plugins directory path
   * 
   * @returns Resolved plugins directory path
   * @throws {PathError} If path resolution fails
   */
  resolvePluginsPath(): string {
    const cacheKey = 'pluginsPath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const stateDir = this.resolveStateDirectory();
    const pluginsPath = path.join(stateDir, 'plugins');
    
    this.validateAndCache(cacheKey, pluginsPath);
    return pluginsPath;
  }

  /**
   * Resolve the workspace directory path
   * 
   * @returns Resolved workspace directory path
   * @throws {PathError} If path resolution fails
   */
  resolveWorkspacePath(): string {
    const cacheKey = 'workspacePath';
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const stateDir = this.resolveStateDirectory();
    const workspacePath = path.join(stateDir, 'workspace');
    
    this.validateAndCache(cacheKey, workspacePath);
    return workspacePath;
  }

  /**
   * Resolve all paths at once
   * 
   * @returns Object containing all resolved paths
   * @throws {PathError} If path resolution fails
   */
  resolveAll(): ResolvedPaths {
    return {
      stateDirectory: this.resolveStateDirectory(),
      configPath: this.resolveConfigPath(),
      databasePath: this.resolveDatabasePath(),
      logPath: this.resolveLogPath(),
      cachePath: this.resolveCachePath(),
      tempPath: this.resolveTempPath(),
      pluginsPath: this.resolvePluginsPath(),
      workspacePath: this.resolveWorkspacePath(),
    };
  }

  /**
   * Get legacy paths for migration
   * 
   * @returns Object containing all legacy paths
   */
  getLegacyPaths(): LegacyPaths {
    return {
      stateDirectory: path.join(this.homeDir, LEGACY_IDENTITY.stateDirectory),
      configPath: path.join(
        this.homeDir,
        LEGACY_IDENTITY.stateDirectory,
        LEGACY_IDENTITY.configFile,
      ),
      databasePath: path.join(
        this.homeDir,
        LEGACY_IDENTITY.stateDirectory,
        LEGACY_IDENTITY.databaseFile,
      ),
      logPath: path.join(
        this.homeDir,
        LEGACY_IDENTITY.stateDirectory,
        'logs',
        LEGACY_IDENTITY.logFile,
      ),
    };
  }

  /**
   * Check if using legacy paths
   * 
   * @returns True if using legacy paths, false otherwise
   */
  isUsingLegacyPaths(): boolean {
    const stateDir = this.resolveStateDirectory();
    const legacyStateDir = path.join(this.homeDir, LEGACY_IDENTITY.stateDirectory);
    
    return stateDir === legacyStateDir;
  }

  /**
   * Ensure all required directories exist
   * 
   * @returns Promise that resolves when directories are created
   * @throws {PathError} If directory creation fails
   */
  async ensureDirectories(): Promise<void> {
    const paths = this.resolveAll();
    
    const directories = [
      paths.stateDirectory,
      paths.cachePath,
      paths.tempPath,
      paths.pluginsPath,
      paths.workspacePath,
      path.dirname(paths.logPath),
    ];

    for (const dir of directories) {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (error) {
        throw new PathError(
          ERROR_MESSAGES.DIRECTORY_CREATION_FAILED + `: ${dir}`,
          IdentityErrorCode.DIRECTORY_CREATION_FAILED,
          error as Error,
          { path: dir },
        );
      }
    }
  }

  /**
   * Validate all paths
   * 
   * @returns Validation result with errors if any
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    try {
      const paths = this.resolveAll();
      
      // Check state directory
      if (!this.isPathValid(paths.stateDirectory)) {
        errors.push(`Invalid state directory: ${paths.stateDirectory}`);
      }
      
      // Check config path
      if (!this.isPathValid(paths.configPath)) {
        errors.push(`Invalid config path: ${paths.configPath}`);
      }
      
      // Check database path
      if (!this.isPathValid(paths.databasePath)) {
        errors.push(`Invalid database path: ${paths.databasePath}`);
      }
      
      // Check log path
      if (!this.isPathValid(paths.logPath)) {
        errors.push(`Invalid log path: ${paths.logPath}`);
      }
      
      // Check cache path
      if (!this.isPathValid(paths.cachePath)) {
        errors.push(`Invalid cache path: ${paths.cachePath}`);
      }
      
      // Check temp path
      if (!this.isPathValid(paths.tempPath)) {
        errors.push(`Invalid temp path: ${paths.tempPath}`);
      }
      
      // Check plugins path
      if (!this.isPathValid(paths.pluginsPath)) {
        errors.push(`Invalid plugins path: ${paths.pluginsPath}`);
      }
      
      // Check workspace path
      if (!this.isPathValid(paths.workspacePath)) {
        errors.push(`Invalid workspace path: ${paths.workspacePath}`);
      }
    } catch (error) {
      errors.push(`Path resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Clear the path cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cached paths
   * 
   * @returns Map of cached paths
   */
  getCache(): Map<string, string> {
    return new Map(this.cache);
  }

  /**
   * Expand path variables (~, $HOME)
   * 
   * @param inputPath - Path to expand
   * @returns Expanded path
   */
  private expandPath(inputPath: string): string {
    let expanded = inputPath;
    
    // Expand ~ to home directory
    if (expanded.startsWith('~')) {
      expanded = path.join(this.homeDir, expanded.slice(1));
    }
    
    // Expand $HOME
    expanded = expanded.replace(/\$HOME/g, this.homeDir);
    
    return expanded;
  }

  /**
   * Check if a path is valid
   * 
   * @param path - Path to check
   * @returns True if path is valid, false otherwise
   */
  private isPathValid(inputPath: string): boolean {
    try {
      // Check if path is absolute
      if (!path.isAbsolute(inputPath)) {
        return false;
      }
      
      // Check if path is accessible
      fs.accessSync(inputPath, fs.constants.F_OK | fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      // Path doesn't exist or isn't accessible
      // This is okay for paths that will be created
      return true;
    }
  }

  /**
   * Validate path and cache it
   * 
   * @param cacheKey - Cache key
   * @param resolvedPath - Resolved path
   * @throws {PathError} If path is invalid
   */
  private validateAndCache(cacheKey: string, resolvedPath: string): void {
    // Validate path if enabled
    if (this.options.validatePaths) {
      if (!this.isPathValid(resolvedPath)) {
        throw new PathError(
          ERROR_MESSAGES.PATH_NOT_FOUND + `: ${resolvedPath}`,
          IdentityErrorCode.PATH_NOT_FOUND,
          undefined,
          { path: resolvedPath },
        );
      }
    }
    
    // Create directory if enabled
    if (this.options.createDirectories) {
      try {
        fs.mkdirSync(resolvedPath, { recursive: true });
      } catch (error) {
        // Ignore errors for files (only create directories)
        if (!resolvedPath.includes('.')) {
          throw new PathError(
            ERROR_MESSAGES.DIRECTORY_CREATION_FAILED + `: ${resolvedPath}`,
            IdentityErrorCode.DIRECTORY_CREATION_FAILED,
            error as Error,
            { path: resolvedPath },
          );
        }
      }
    }
    
    // Cache the path
    this.cache.set(cacheKey, resolvedPath);
  }

  /**
   * Get path resolution details
   * 
   * @param pathType - Type of path
   * @returns Path resolution details
   */
  getPathDetails(pathType: keyof ResolvedPaths): PathResolutionResult {
    const paths = this.resolveAll();
    const resolvedPath = paths[pathType];
    const exists = fs.existsSync(resolvedPath);
    
    // Check if using legacy path
    let isLegacy = false;
    if (pathType === 'stateDirectory') {
      const legacyStateDir = path.join(this.homeDir, LEGACY_IDENTITY.stateDirectory);
      isLegacy = resolvedPath === legacyStateDir;
    }
    
    return {
      path: resolvedPath,
      exists,
      isLegacy,
    };
  }

  /**
   * Format paths for display
   * 
   * @returns Formatted paths string
   */
  formatForDisplay(): string {
    const paths = this.resolveAll();
    const isLegacy = this.isUsingLegacyPaths();
    
    return `
State Directory: ${paths.stateDirectory} ${isLegacy ? '(legacy)' : ''}
Config File: ${paths.configPath}
Database: ${paths.databasePath}
Log File: ${paths.logPath}
Cache Directory: ${paths.cachePath}
Temp Directory: ${paths.tempPath}
Plugins Directory: ${paths.pluginsPath}
Workspace Directory: ${paths.workspacePath}
    `.trim();
  }

  /**
   * Export paths as JSON
   * 
   * @returns JSON string
   */
  exportAsJson(): string {
    const paths = this.resolveAll();
    const details = {
      paths,
      isUsingLegacyPaths: this.isUsingLegacyPaths(),
      homeDir: this.homeDir,
    };
    
    return JSON.stringify(details, null, 2);
  }

  /**
   * Singleton instance
   */
  private static instance: PathResolver | null = null;

  /**
   * Get singleton PathResolver instance
   * 
   * @returns PathResolver instance
   */
  static getInstance(): PathResolver {
    if (!PathResolver.instance) {
      PathResolver.instance = new PathResolver();
    }
    return PathResolver.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    PathResolver.instance = null;
  }
}

/**
 * Get singleton PathResolver instance
 * 
 * @returns PathResolver instance
 */
export function getPathResolver(): PathResolver {
  return PathResolver.getInstance();
}

/**
 * Reset singleton PathResolver instance
 */
export function resetPathResolver(): void {
  PathResolver.resetInstance();
}
