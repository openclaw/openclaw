/**
 * Titanium Claws Identity Service
 * 
 * High-level API for accessing product identity information.
 * This service provides convenient methods for retrieving product metadata,
 * branding information, and configuration details.
 */

import {
  PRODUCT_IDENTITY,
  LEGACY_IDENTITY,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_TYPOGRAPHY,
} from './constants.js';
import type {
  ProductIdentity,
  LegacyIdentity,
  BrandingConfig,
  ColorScheme,
  Typography,
  URLs,
  Legal,
  TitaniumClawsConfig,
} from './types.js';
import {
  IdentityError,
  IdentityErrorCode,
  createRuntimeError,
  createConfigError,
} from './errors.js';

/**
 * Options for IdentityService initialization.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface IdentityServiceOptions {
  /**
   * Override product identity (useful for testing).
   */
  readonly productIdentity?: Partial<ProductIdentity>;
  
  /**
   * Override legacy identity (useful for testing).
   */
  readonly legacyIdentity?: Partial<LegacyIdentity>;
  
  /**
   * Configuration file path.
   */
  readonly configPath?: string;
}

/**
 * Product information summary.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ProductInfo {
  readonly displayName: string;
  readonly shortName: string;
  readonly version: string;
  readonly tagline: string;
  readonly description: string;
  readonly executable: string;
  readonly packageScope: string;
  readonly repository: string;
  readonly stateDirectory: string;
  readonly configFile: string;
}

/**
 * Identity Service - High-level API for product identity management.
 * 
 * This service provides convenient methods for accessing product identity
 * information, branding details, and configuration data.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class IdentityService {
  private readonly productIdentity: ProductIdentity;
  private readonly legacyIdentity: LegacyIdentity;
  private readonly options: IdentityServiceOptions;
  private initialized: boolean = false;

  /**
   * Create a new IdentityService instance.
   * 
   * @param options - Service options
   */
  constructor(options: IdentityServiceOptions = {}) {
    this.options = options;
    
    // Merge overrides with defaults
    this.productIdentity = {
      ...PRODUCT_IDENTITY,
      ...options.productIdentity,
    } as ProductIdentity;
    
    this.legacyIdentity = {
      ...LEGACY_IDENTITY,
      ...options.legacyIdentity,
    } as LegacyIdentity;
    
    this.initialized = true;
  }

  // ─── Public Identity Methods ──────────────────────────────────────────────

  /**
   * Get full product display name.
   * 
   * @returns Product display name
   * @throws {RuntimeError} If service not initialized
   */
  getDisplayName(): string {
    this.ensureInitialized();
    return this.productIdentity.displayName;
  }

  /**
   * Get short product name.
   * 
   * @returns Short product name
   * @throws {RuntimeError} If service not initialized
   */
  getShortName(): string {
    this.ensureInitialized();
    return this.productIdentity.shortName;
  }

  /**
   * Get product tagline.
   * 
   * @returns Product tagline
   * @throws {RuntimeError} If service not initialized
   */
  getTagline(): string {
    this.ensureInitialized();
    return this.productIdentity.tagline;
  }

  /**
   * Get full product description.
   * 
   * @returns Product description
   * @throws {RuntimeError} If service not initialized
   */
  getDescription(): string {
    this.ensureInitialized();
    return this.productIdentity.description;
  }

  // ─── Technical Identity Methods ───────────────────────────────────────────

  /**
   * Get CLI executable name.
   * 
   * @param options.full - Use full name instead of short name
   * @returns Executable name
   * @throws {RuntimeError} If service not initialized
   */
  getExecutableName(options?: { full?: boolean }): string {
    this.ensureInitialized();
    return options?.full
      ? this.productIdentity.executableFull
      : this.productIdentity.executable;
  }

  /**
   * Get NPM package scope.
   * 
   * @returns Package scope
   * @throws {RuntimeError} If service not initialized
   */
  getPackageScope(): string {
    this.ensureInitialized();
    return this.productIdentity.packageScope;
  }

  /**
   * Get repository identifier.
   * 
   * @returns Repository identifier (org/repo)
   * @throws {RuntimeError} If service not initialized
   */
  getRepository(): string {
    this.ensureInitialized();
    return this.productIdentity.repository;
  }

  // ─── Configuration Methods ────────────────────────────────────────────────

  /**
   * Get state directory name.
   * 
   * @returns State directory name
   * @throws {RuntimeError} If service not initialized
   */
  getStateDirectoryName(): string {
    this.ensureInitialized();
    return this.productIdentity.stateDirectory;
  }

  /**
   * Get configuration file name.
   * 
   * @returns Configuration file name
   * @throws {RuntimeError} If service not initialized
   */
  getConfigFileName(): string {
    this.ensureInitialized();
    return this.productIdentity.configFile;
  }

  /**
   * Get environment variable prefix.
   * 
   * @returns Environment variable prefix
   * @throws {RuntimeError} If service not initialized
   */
  getEnvPrefix(): string {
    this.ensureInitialized();
    return this.productIdentity.envPrefix;
  }

  // ─── Versioning Methods ───────────────────────────────────────────────────

  /**
   * Get product version.
   * 
   * @returns Product version
   * @throws {RuntimeError} If service not initialized
   */
  getVersion(): string {
    this.ensureInitialized();
    return this.productIdentity.version;
  }

  /**
   * Get OpenClaw compatibility version.
   * 
   * @returns Compatible OpenClaw version
   * @throws {RuntimeError} If service not initialized
   */
  getOpenClawCompatibilityVersion(): string {
    this.ensureInitialized();
    return this.productIdentity.openclawCompatibility;
  }

  /**
   * Check compatibility with OpenClaw version.
   * 
   * @param version - OpenClaw version to check
   * @returns True if compatible
   * @throws {RuntimeError} If service not initialized
   */
  isCompatibleWithOpenClaw(version: string): boolean {
    this.ensureInitialized();
    
    try {
      const [major, minor, patch] = version.split('.').map(Number);
      const compatVersion = this.productIdentity.openclawCompatibility;
      
      // Simple version comparison
      return version === compatVersion || 
             (major === 2026 && minor >= 7 && patch >= 2);
    } catch {
      return false;
    }
  }

  // ─── Branding Methods ─────────────────────────────────────────────────────

  /**
   * Get logo path.
   * 
   * @param theme - Theme (light or dark)
   * @returns Logo path
   * @throws {RuntimeError} If service not initialized
   */
  getLogoPath(theme: 'light' | 'dark' = 'light'): string {
    this.ensureInitialized();
    return theme === 'dark'
      ? this.productIdentity.branding.logo.dark
      : this.productIdentity.branding.logo.light;
  }

  /**
   * Get color scheme.
   * 
   * @returns Color scheme
   * @throws {RuntimeError} If service not initialized
   */
  getColorScheme(): ColorScheme {
    this.ensureInitialized();
    return this.productIdentity.branding.colors;
  }

  /**
   * Get typography configuration.
   * 
   * @returns Typography configuration
   * @throws {RuntimeError} If service not initialized
   */
  getTypography(): Typography {
    this.ensureInitialized();
    return this.productIdentity.branding.typography;
  }

  // ─── Documentation Methods ────────────────────────────────────────────────

  /**
   * Get website URL.
   * 
   * @returns Website URL
   * @throws {RuntimeError} If service not initialized
   */
  getWebsiteUrl(): string {
    this.ensureInitialized();
    return this.productIdentity.urls.website;
  }

  /**
   * Get documentation URL.
   * 
   * @returns Documentation URL
   * @throws {RuntimeError} If service not initialized
   */
  getDocsUrl(): string {
    this.ensureInitialized();
    return this.productIdentity.urls.docs;
  }

  /**
   * Get repository URL.
   * 
   * @returns Repository URL
   * @throws {RuntimeError} If service not initialized
   */
  getRepositoryUrl(): string {
    this.ensureInitialized();
    return this.productIdentity.urls.repository;
  }

  /**
   * Get support email.
   * 
   * @returns Support email
   * @throws {RuntimeError} If service not initialized
   */
  getSupportEmail(): string {
    this.ensureInitialized();
    return this.productIdentity.urls.support;
  }

  // ─── Legal Methods ────────────────────────────────────────────────────────

  /**
   * Get license type.
   * 
   * @returns License type
   * @throws {RuntimeError} If service not initialized
   */
  getLicense(): string {
    this.ensureInitialized();
    return this.productIdentity.legal.license;
  }

  /**
   * Get copyright notice.
   * 
   * @returns Copyright notice
   * @throws {RuntimeError} If service not initialized
   */
  getCopyright(): string {
    this.ensureInitialized();
    return this.productIdentity.legal.copyright;
  }

  // ─── Legacy Compatibility Methods ─────────────────────────────────────────

  /**
   * Get legacy OpenClaw executable name.
   * 
   * @returns Legacy executable name
   * @throws {RuntimeError} If service not initialized
   */
  getLegacyExecutableName(): string {
    this.ensureInitialized();
    return this.legacyIdentity.executable;
  }

  /**
   * Get legacy package scope.
   * 
   * @returns Legacy package scope
   * @throws {RuntimeError} If service not initialized
   */
  getLegacyPackageScope(): string {
    this.ensureInitialized();
    return this.legacyIdentity.packageScope;
  }

  /**
   * Get legacy state directory.
   * 
   * @returns Legacy state directory
   * @throws {RuntimeError} If service not initialized
   */
  getLegacyStateDirectoryName(): string {
    this.ensureInitialized();
    return this.legacyIdentity.stateDirectory;
  }

  /**
   * Get legacy environment prefix.
   * 
   * @returns Legacy environment prefix
   * @throws {RuntimeError} If service not initialized
   */
  getLegacyEnvPrefix(): string {
    this.ensureInitialized();
    return this.legacyIdentity.envPrefix;
  }

  // ─── Aggregate Methods ────────────────────────────────────────────────────

  /**
   * Get product information summary.
   * 
   * @returns Product information
   * @throws {RuntimeError} If service not initialized
   */
  getProductInfo(): ProductInfo {
    this.ensureInitialized();
    return {
      displayName: this.productIdentity.displayName,
      shortName: this.productIdentity.shortName,
      version: this.productIdentity.version,
      tagline: this.productIdentity.tagline,
      description: this.productIdentity.description,
      executable: this.productIdentity.executable,
      packageScope: this.productIdentity.packageScope,
      repository: this.productIdentity.repository,
      stateDirectory: this.productIdentity.stateDirectory,
      configFile: this.productIdentity.configFile,
    };
  }

  /**
   * Get complete branding configuration.
   * 
   * @returns Branding configuration
   * @throws {RuntimeError} If service not initialized
   */
  getBranding(): BrandingConfig {
    this.ensureInitialized();
    return this.productIdentity.branding;
  }

  /**
   * Get documentation URLs.
   * 
   * @returns URLs
   * @throws {RuntimeError} If service not initialized
   */
  getUrls(): URLs {
    this.ensureInitialized();
    return this.productIdentity.urls;
  }

  /**
   * Get legal information.
   * 
   * @returns Legal information
   * @throws {RuntimeError} If service not initialized
   */
  getLegal(): Legal {
    this.ensureInitialized();
    return this.productIdentity.legal;
  }

  /**
   * Get complete product identity.
   * 
   * @returns Product identity
   * @throws {RuntimeError} If service not initialized
   */
  getIdentity(): ProductIdentity {
    this.ensureInitialized();
    return { ...this.productIdentity };
  }

  /**
   * Format identity for display.
   * 
   * @returns Formatted identity string
   * @throws {RuntimeError} If service not initialized
   */
  formatForDisplay(): string {
    this.ensureInitialized();
    
    return `
${this.productIdentity.displayName} v${this.productIdentity.version}
${this.productIdentity.tagline}

Executable: ${this.productIdentity.executable}
Package Scope: ${this.productIdentity.packageScope}
State Directory: ${this.productIdentity.stateDirectory}
Config File: ${this.productIdentity.configFile}

Website: ${this.productIdentity.urls.website}
Documentation: ${this.productIdentity.urls.docs}
Repository: ${this.productIdentity.urls.repository}

${this.productIdentity.legal.copyright}
License: ${this.productIdentity.legal.license}
    `.trim();
  }

  /**
   * Export identity as JSON.
   * 
   * @returns JSON string
   * @throws {RuntimeError} If service not initialized
   */
  exportAsJson(): string {
    this.ensureInitialized();
    return JSON.stringify(this.productIdentity, null, 2);
  }

  /**
   * Validate identity configuration.
   * 
   * @returns Validation result
   * @throws {RuntimeError} If service not initialized
   */
  validate(): { valid: boolean; errors: string[] } {
    this.ensureInitialized();
    
    const errors: string[] = [];
    
    // Check required fields
    if (!this.productIdentity.displayName) {
      errors.push('Missing displayName');
    }
    
    if (!this.productIdentity.version) {
      errors.push('Missing version');
    }
    
    if (!this.productIdentity.executable) {
      errors.push('Missing executable');
    }
    
    // Check version format
    if (this.productIdentity.version && 
        !/^\d+\.\d+\.\d+/.test(this.productIdentity.version)) {
      errors.push('Invalid version format');
    }
    
    // Check URLs
    if (!this.productIdentity.urls.website.startsWith('https://')) {
      errors.push('Website URL must use HTTPS');
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // ─── Configuration Loading ────────────────────────────────────────────────

  /**
   * Load configuration from file.
   * 
   * @param configPath - Configuration file path
   * @returns Configuration object
   * @throws {ConfigError} If configuration invalid
   * @throws {RuntimeError} If service not initialized
   */
  async loadConfig(configPath: string): Promise<TitaniumClawsConfig> {
    this.ensureInitialized();
    
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content) as TitaniumClawsConfig;
      
      // Validate configuration
      if (!config.version) {
        throw createConfigError('Configuration missing version field');
      }
      
      return config;
    } catch (error) {
      if (error instanceof IdentityError) {
        throw error;
      }
      
      throw createConfigError(
        `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  /**
   * Ensure service is initialized.
   * 
   * @throws {RuntimeError} If service not initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw createRuntimeError('Identity service not initialized');
    }
  }
}

/**
 * Singleton instance of IdentityService.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
let identityServiceInstance: IdentityService | null = null;

/**
 * Get singleton IdentityService instance.
 * 
 * @returns IdentityService instance
 */
export function getIdentityService(): IdentityService {
  if (!identityServiceInstance) {
    identityServiceInstance = new IdentityService();
  }
  return identityServiceInstance;
}

/**
 * Reset singleton IdentityService instance (for testing).
 */
export function resetIdentityService(): void {
  identityServiceInstance = null;
}
