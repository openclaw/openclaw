# Titanium Claws Identity Layer Specification

**Status**: Draft  
**Created**: 2026-07-21  
**Version**: 1.0.0  
**RFC**: See `01-ARCHITECTURE-RFC.md`

---

## Executive Summary

This specification defines the **Identity Layer**, a centralized system for managing all product identity, configuration paths, environment variables, and branding resources. The Identity Layer serves as the single source of truth for the Titanium Claws product, enabling consistent branding, easy future rebranding, and clean separation of concerns.

### Key Benefits

1. **Single Source of Truth**: All product identity defined in one place
2. **Easy Rebranding**: Change product name once, updates propagate everywhere
3. **Backward Compatibility**: Automatic fallback to OpenClaw paths and variables
4. **Type Safety**: Full TypeScript type checking for all identity operations
5. **Testability**: Identity logic isolated and easily testable

---

## 1. Architecture Overview

### 1.1 Component Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│                   Identity Layer                         │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────┐  │
│  │  IdentityService (Public API)                    │  │
│  │  - getDisplayName()                              │  │
│  │  - getExecutableName()                           │  │
│  │  - getVersion()                                  │  │
│  └──────────────────────────────────────────────────┘  │
│                          │                              │
│  ┌───────────────────────┼────────────────────────┐    │
│  │                       ▼                         │    │
│  │  ┌─────────────────────────────────────────┐   │    │
│  │  │ PRODUCT_IDENTITY (Configuration)        │   │    │
│  │  │ - displayName, shortName, executable    │   │    │
│  │  │ - stateDirectory, configFile            │   │    │
│  │  │ - envPrefix, packageScope               │   │    │
│  │  │ - logo, colorScheme                     │   │    │
│  │  └─────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────┘    │
│                          │                              │
│  ┌───────────────────────┼────────────────────────┐    │
│  │                       ▼                         │    │
│  │  ┌─────────────────────────────────────────┐   │    │
│  │  │ PathResolver (Filesystem Abstraction)   │   │    │
│  │  │ - resolveStateDirectory()               │   │    │
│  │  │ - resolveConfigPath()                   │   │    │
│  │  │ - resolveDatabasePath()                 │   │    │
│  │  │ - resolveLogPath()                      │   │    │
│  │  └─────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────┘    │
│                          │                              │
│  ┌───────────────────────┼────────────────────────┐    │
│  │                       ▼                         │    │
│  │  ┌─────────────────────────────────────────┐   │    │
│  │  │ EnvironmentResolver (Env Abstraction)   │   │    │
│  │  │ - resolveStateDir()                     │   │    │
│  │  │ - resolveConfigPath()                   │   │    │
│  │  │ - resolveGatewayToken()                 │   │    │
│  │  └─────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────┘    │
│                          │                              │
│  ┌───────────────────────┼────────────────────────┐    │
│  │                       ▼                         │    │
│  │  ┌─────────────────────────────────────────┐   │    │
│  │  │ CompatibilityLayer (Fallback Logic)     │   │    │
│  │  │ - isLegacyConfigPresent()               │   │    │
│  │  │ - getLegacyStateDirectory()             │   │    │
│  │  │ - migrateToNewIdentity()                │   │    │
│  │  └─────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow

```
User Request
     │
     ▼
IdentityService.getExecutableName()
     │
     ▼
PRODUCT_IDENTITY.executable
     │
     ▼
"tc" (or "titanium-claws" if full name requested)
```

### 1.3 Integration Points

| Component | Integration | Example |
|-----------|-------------|---------|
| **CLI** | Uses `IdentityService` | `tc gateway start` |
| **Config Loader** | Uses `PathResolver` | Load `~/.titanium-claws/titanium-claws.json` |
| **Environment** | Uses `EnvironmentResolver` | Read `TITANIUM_CLAWS_GATEWAY_TOKEN` |
| **Logger** | Uses `IdentityService` | Prefix logs with `[Titanium Claws]` |
| **Metrics** | Uses `IdentityService` | Label metrics with product name |
| **UI** | Uses `IdentityService` | Display logo and branding |

---

## 2. Core Types

### 2.1 Product Identity

```typescript
/**
 * Complete product identity definition
 */
export interface ProductIdentity {
  // Public Identity
  displayName: string           // "Titanium Claws"
  shortName: string             // "Titanium"
  tagline: string               // "Rust-Powered Multi-Agent Intelligence"
  description: string           // Full product description
  
  // Technical Identity
  executable: string            // "tc"
  executableFull: string        // "titanium-claws"
  packageScope: string          // "@titanium-claws"
  repository: string            // "titanium-claws/titanium-claws"
  
  // Configuration
  stateDirectory: string        // ".titanium-claws"
  configFile: string            // "titanium-claws.json"
  databaseFile: string          // "titanium-claws.sqlite"
  logFile: string               // "titanium-claws.log"
  envPrefix: string             // "TITANIUM_CLAWS"
  
  // Versioning
  version: string               // "1.0.0"
  openclawCompatibility: string // "2026.7.2"
  protocolVersion: string       // "1.0.0"
  
  // Branding
  logo: BrandingAssets
  colorScheme: ColorScheme
  typography: Typography
  
  // Documentation
  website: string               // "https://titaniumclaws.ai"
  docs: string                  // "https://docs.titaniumclaws.ai"
  repositoryUrl: string         // "https://github.com/titanium-claws/titanium-claws"
  supportEmail: string          // "support@titaniumclaws.ai"
  
  // Legal
  license: string               // "MIT"
  copyright: string             // "© 2026 Titanium Claws Contributors"
}

export interface BrandingAssets {
  logo: string                  // Path to logo
  logoDark: string              // Dark mode logo
  logoLight: string             // Light mode logo
  icon: string                  // Favicon/app icon
  banner: string                // Social media banner
}

export interface ColorScheme {
  primary: string               // "#4A5568" (Titanium Gray)
  secondary: string             // "#2C5282" (Steel Blue)
  accent: string                // "#E53E3E" (Lobster Red)
  success: string               // "#38A169" (Performance Green)
  warning: string               // "#D69E2E" (Benchmark Yellow)
  error: string                 // "#C53030" (Critical Red)
  background: string            // "#FFFFFF" (White)
  text: string                  // "#1A202C" (Dark Gray)
}

export interface Typography {
  fontFamily: string            // "Inter, sans-serif"
  fontFamilyMono: string        // "JetBrains Mono, monospace"
  fontSize: {
    xs: string                  // "12px"
    sm: string                  // "14px"
    base: string                // "16px"
    lg: string                  // "18px"
    xl: string                  // "20px"
    "2xl": string               // "24px"
    "3xl": string               // "30px"
    "4xl": string               // "36px"
  }
  fontWeight: {
    light: number               // 300
    normal: number              // 400
    medium: number              // 500
    semibold: number            // 600
    bold: number                // 700
  }
}
```

### 2.2 Compatibility Layer

```typescript
/**
 * Legacy OpenClaw identity for backward compatibility
 */
export interface LegacyIdentity {
  displayName: string           // "OpenClaw"
  executable: string            // "openclaw"
  packageScope: string          // "@openclaw"
  stateDirectory: string        // ".openclaw"
  configFile: string            // "openclaw.json"
  envPrefix: string             // "OPENCLAW"
}

/**
 * Migration status from OpenClaw to Titanium Claws
 */
export interface MigrationStatus {
  migrated: boolean
  migratedAt?: Date
  fromVersion?: string
  toVersion?: string
  backupPath?: string
  errors?: string[]
}
```

### 2.3 Path Types

```typescript
/**
 * Resolved filesystem paths
 */
export interface ResolvedPaths {
  stateDirectory: string
  configPath: string
  databasePath: string
  logPath: string
  cachePath: string
  tempPath: string
  pluginsPath: string
  workspacePath: string
}

/**
 * Legacy paths for fallback
 */
export interface LegacyPaths {
  stateDirectory: string
  configPath: string
  databasePath: string
  logPath: string
}
```

### 2.4 Environment Types

```typescript
/**
 * Resolved environment variables
 */
export interface ResolvedEnvironment {
  stateDir: string | undefined
  configPath: string | undefined
  gatewayToken: string | undefined
  gatewayPassword: string | undefined
  logLevel: string | undefined
  databaseUrl: string | undefined
  redisUrl: string | undefined
}
```

---

## 3. Core Services

### 3.1 Identity Service

```typescript
/**
 * Main public API for accessing product identity
 */
export class IdentityService {
  private identity: ProductIdentity
  private legacy: LegacyIdentity
  private pathResolver: PathResolver
  private envResolver: EnvironmentResolver
  
  constructor(identity: ProductIdentity, legacy: LegacyIdentity) {
    this.identity = identity
    this.legacy = legacy
    this.pathResolver = new PathResolver(identity, legacy)
    this.envResolver = new EnvironmentResolver(identity, legacy)
  }
  
  // ─── Public Identity ───────────────────────────────────────────────
  
  /**
   * Get full product display name
   * @returns "Titanium Claws"
   */
  getDisplayName(): string {
    return this.identity.displayName
  }
  
  /**
   * Get short product name
   * @returns "Titanium"
   */
  getShortName(): string {
    return this.identity.shortName
  }
  
  /**
   * Get product tagline
   * @returns "Rust-Powered Multi-Agent Intelligence"
   */
  getTagline(): string {
    return this.identity.tagline
  }
  
  /**
   * Get full product description
   */
  getDescription(): string {
    return this.identity.description
  }
  
  // ─── Technical Identity ────────────────────────────────────────────
  
  /**
   * Get CLI executable name
   * @param options.full - Use full name instead of short name
   * @returns "tc" or "titanium-claws"
   */
  getExecutableName(options?: { full?: boolean }): string {
    return options?.full ? this.identity.executableFull : this.identity.executable
  }
  
  /**
   * Get NPM package scope
   * @returns "@titanium-claws"
   */
  getPackageScope(): string {
    return this.identity.packageScope
  }
  
  /**
   * Get repository identifier
   * @returns "titanium-claws/titanium-claws"
   */
  getRepository(): string {
    return this.identity.repository
  }
  
  // ─── Configuration ─────────────────────────────────────────────────
  
  /**
   * Get state directory name
   * @returns ".titanium-claws"
   */
  getStateDirectoryName(): string {
    return this.identity.stateDirectory
  }
  
  /**
   * Get config file name
   * @returns "titanium-claws.json"
   */
  getConfigFileName(): string {
    return this.identity.configFile
  }
  
  /**
   * Get environment variable prefix
   * @returns "TITANIUM_CLAWS"
   */
  getEnvPrefix(): string {
    return this.identity.envPrefix
  }
  
  // ─── Versioning ────────────────────────────────────────────────────
  
  /**
   * Get product version
   * @returns "1.0.0"
   */
  getVersion(): string {
    return this.identity.version
  }
  
  /**
   * Get OpenClaw compatibility version
   * @returns "2026.7.2"
   */
  getOpenClawCompatibilityVersion(): string {
    return this.identity.openclawCompatibility
  }
  
  /**
   * Check compatibility with OpenClaw version
   */
  isCompatibleWithOpenClaw(version: string): boolean {
    // Implement version comparison logic
    return true
  }
  
  // ─── Branding ──────────────────────────────────────────────────────
  
  /**
   * Get logo path
   */
  getLogoPath(theme: "light" | "dark" = "light"): string {
    return theme === "dark" 
      ? this.identity.logo.logoDark 
      : this.identity.logo.logoLight
  }
  
  /**
   * Get color scheme
   */
  getColorScheme(): ColorScheme {
    return this.identity.colorScheme
  }
  
  /**
   * Get typography configuration
   */
  getTypography(): Typography {
    return this.identity.typography
  }
  
  // ─── Documentation ─────────────────────────────────────────────────
  
  /**
   * Get website URL
   */
  getWebsiteUrl(): string {
    return this.identity.website
  }
  
  /**
   * Get documentation URL
   */
  getDocsUrl(): string {
    return this.identity.docs
  }
  
  /**
   * Get repository URL
   */
  getRepositoryUrl(): string {
    return this.identity.repositoryUrl
  }
  
  /**
   * Get support email
   */
  getSupportEmail(): string {
    return this.identity.supportEmail
  }
  
  // ─── Legal ─────────────────────────────────────────────────────────
  
  /**
   * Get license type
   */
  getLicense(): string {
    return this.identity.license
  }
  
  /**
   * Get copyright notice
   */
  getCopyright(): string {
    return this.identity.copyright
  }
  
  // ─── Legacy Compatibility ──────────────────────────────────────────
  
  /**
   * Get legacy OpenClaw executable name
   * @returns "openclaw"
   */
  getLegacyExecutableName(): string {
    return this.legacy.executable
  }
  
  /**
   * Get legacy package scope
   * @returns "@openclaw"
   */
  getLegacyPackageScope(): string {
    return this.legacy.packageScope
  }
  
  /**
   * Get legacy state directory
   * @returns ".openclaw"
   */
  getLegacyStateDirectoryName(): string {
    return this.legacy.stateDirectory
  }
  
  /**
   * Get legacy environment prefix
   * @returns "OPENCLAW"
   */
  getLegacyEnvPrefix(): string {
    return this.legacy.envPrefix
  }
  
  // ─── Path Resolution ──────────────────────────────────────────────
  
  /**
   * Resolve all filesystem paths
   */
  resolvePaths(): ResolvedPaths {
    return this.pathResolver.resolve()
  }
  
  /**
   * Resolve state directory path
   */
  resolveStateDirectory(): string {
    return this.pathResolver.resolveStateDirectory()
  }
  
  /**
   * Resolve config file path
   */
  resolveConfigPath(): string {
    return this.pathResolver.resolveConfigPath()
  }
  
  /**
   * Resolve database path
   */
  resolveDatabasePath(): string {
    return this.pathResolver.resolveDatabasePath()
  }
  
  /**
   * Resolve log file path
   */
  resolveLogPath(): string {
    return this.pathResolver.resolveLogPath()
  }
  
  // ─── Environment Resolution ────────────────────────────────────────
  
  /**
   * Resolve all environment variables
   */
  resolveEnvironment(): ResolvedEnvironment {
    return this.envResolver.resolve()
  }
  
  /**
   * Resolve state directory from environment
   */
  resolveStateDir(): string | undefined {
    return this.envResolver.resolveStateDir()
  }
  
  /**
   * Resolve config path from environment
   */
  resolveConfigPath(): string | undefined {
    return this.envResolver.resolveConfigPath()
  }
  
  /**
   * Resolve gateway token from environment
   */
  resolveGatewayToken(): string | undefined {
    return this.envResolver.resolveGatewayToken()
  }
  
  // ─── Utility Methods ───────────────────────────────────────────────
  
  /**
   * Get complete identity object
   */
  getIdentity(): ProductIdentity {
    return { ...this.identity }
  }
  
  /**
   * Format identity for display
   */
  formatForDisplay(): string {
    return `
${this.identity.displayName} v${this.identity.version}
${this.identity.tagline}

Executable: ${this.identity.executable}
Package Scope: ${this.identity.packageScope}
State Directory: ${this.identity.stateDirectory}
Config File: ${this.identity.configFile}

Website: ${this.identity.website}
Documentation: ${this.identity.docs}
Repository: ${this.identity.repositoryUrl}

${this.identity.copyright}
License: ${this.identity.license}
    `.trim()
  }
  
  /**
   * Export identity as JSON
   */
  exportAsJson(): string {
    return JSON.stringify(this.identity, null, 2)
  }
  
  /**
   * Validate identity configuration
   */
  validate(): ValidationResult {
    const errors: string[] = []
    
    // Check required fields
    if (!this.identity.displayName) {
      errors.push("displayName is required")
    }
    
    if (!this.identity.executable) {
      errors.push("executable is required")
    }
    
    if (!this.identity.version) {
      errors.push("version is required")
    }
    
    // Check version format
    if (this.identity.version && !this.isValidSemver(this.identity.version)) {
      errors.push(`Invalid version format: ${this.identity.version}`)
    }
    
    // Check paths
    if (!this.identity.stateDirectory.startsWith(".")) {
      errors.push(`stateDirectory should start with dot: ${this.identity.stateDirectory}`)
    }
    
    // Check URLs
    if (!this.isValidUrl(this.identity.website)) {
      errors.push(`Invalid website URL: ${this.identity.website}`)
    }
    
    return {
      valid: errors.length === 0,
      errors
    }
  }
  
  private isValidSemver(version: string): boolean {
    return /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)
  }
  
  private isValidUrl(url: string): boolean {
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  }
}

interface ValidationResult {
  valid: boolean
  errors: string[]
}
```

### 3.2 Path Resolver

```typescript
/**
 * Resolves filesystem paths with backward compatibility
 */
export class PathResolver {
  private identity: ProductIdentity
  private legacy: LegacyIdentity
  
  constructor(identity: ProductIdentity, legacy: LegacyIdentity) {
    this.identity = identity
    this.legacy = legacy
  }
  
  /**
   * Resolve all paths
   */
  resolve(): ResolvedPaths {
    return {
      stateDirectory: this.resolveStateDirectory(),
      configPath: this.resolveConfigPath(),
      databasePath: this.resolveDatabasePath(),
      logPath: this.resolveLogPath(),
      cachePath: this.resolveCachePath(),
      tempPath: this.resolveTempPath(),
      pluginsPath: this.resolvePluginsPath(),
      workspacePath: this.resolveWorkspacePath(),
    }
  }
  
  /**
   * Resolve state directory
   * Priority:
   * 1. Environment variable (TITANIUM_CLAWS_STATE_DIR)
   * 2. New path (~/.titanium-claws)
   * 3. Legacy path (~/.openclaw)
   */
  resolveStateDirectory(): string {
    const envPath = process.env[`${this.identity.envPrefix}_STATE_DIR`]
    if (envPath) {
      return envPath
    }
    
    const homeDir = this.getHomeDirectory()
    const newPath = path.join(homeDir, this.identity.stateDirectory)
    
    if (fs.existsSync(newPath)) {
      return newPath
    }
    
    const legacyPath = path.join(homeDir, this.legacy.stateDirectory)
    if (fs.existsSync(legacyPath)) {
      return legacyPath
    }
    
    return newPath // Default to new path
  }
  
  /**
   * Resolve config file path
   */
  resolveConfigPath(): string {
    const envPath = process.env[`${this.identity.envPrefix}_CONFIG_PATH`]
    if (envPath) {
      return envPath
    }
    
    const stateDir = this.resolveStateDirectory()
    const newPath = path.join(stateDir, this.identity.configFile)
    
    if (fs.existsSync(newPath)) {
      return newPath
    }
    
    const legacyPath = path.join(stateDir, this.legacy.configFile)
    if (fs.existsSync(legacyPath)) {
      return legacyPath
    }
    
    return newPath
  }
  
  /**
   * Resolve database path
   */
  resolveDatabasePath(): string {
    const stateDir = this.resolveStateDirectory()
    return path.join(stateDir, this.identity.databaseFile)
  }
  
  /**
   * Resolve log file path
   */
  resolveLogPath(): string {
    const stateDir = this.resolveStateDirectory()
    const logsDir = path.join(stateDir, "logs")
    return path.join(logsDir, this.identity.logFile)
  }
  
  /**
   * Resolve cache directory
   */
  resolveCachePath(): string {
    const stateDir = this.resolveStateDirectory()
    return path.join(stateDir, "cache")
  }
  
  /**
   * Resolve temporary directory
   */
  resolveTempPath(): string {
    const stateDir = this.resolveStateDirectory()
    return path.join(stateDir, "temp")
  }
  
  /**
   * Resolve plugins directory
   */
  resolvePluginsPath(): string {
    const stateDir = this.resolveStateDirectory()
    return path.join(stateDir, "plugins")
  }
  
  /**
   * Resolve workspace directory
   */
  resolveWorkspacePath(): string {
    const stateDir = this.resolveStateDirectory()
    return path.join(stateDir, "workspace")
  }
  
  /**
   * Get legacy paths for migration
   */
  getLegacyPaths(): LegacyPaths {
    const homeDir = this.getHomeDirectory()
    const legacyStateDir = path.join(homeDir, this.legacy.stateDirectory)
    
    return {
      stateDirectory: legacyStateDir,
      configPath: path.join(legacyStateDir, this.legacy.configFile),
      databasePath: path.join(legacyStateDir, "openclaw.sqlite"),
      logPath: path.join(legacyStateDir, "logs", "openclaw.log"),
    }
  }
  
  /**
   * Check if legacy paths exist
   */
  legacyPathsExist(): boolean {
    const legacyPaths = this.getLegacyPaths()
    return fs.existsSync(legacyPaths.stateDirectory)
  }
  
  /**
   * Ensure all directories exist
   */
  async ensureDirectories(): Promise<void> {
    const paths = this.resolve()
    
    const directories = [
      paths.stateDirectory,
      paths.cachePath,
      paths.tempPath,
      paths.pluginsPath,
      paths.workspacePath,
      path.dirname(paths.logPath),
    ]
    
    for (const dir of directories) {
      await fs.promises.mkdir(dir, { recursive: true })
    }
  }
  
  /**
   * Get home directory
   */
  private getHomeDirectory(): string {
    return process.env.HOME || process.env.USERPROFILE || os.homedir()
  }
}
```

### 3.3 Environment Resolver

```typescript
/**
 * Resolves environment variables with backward compatibility
 */
export class EnvironmentResolver {
  private identity: ProductIdentity
  private legacy: LegacyIdentity
  
  constructor(identity: ProductIdentity, legacy: LegacyIdentity) {
    this.identity = identity
    this.legacy = legacy
  }
  
  /**
   * Resolve all environment variables
   */
  resolve(): ResolvedEnvironment {
    return {
      stateDir: this.resolveStateDir(),
      configPath: this.resolveConfigPath(),
      gatewayToken: this.resolveGatewayToken(),
      gatewayPassword: this.resolveGatewayPassword(),
      logLevel: this.resolveLogLevel(),
      databaseUrl: this.resolveDatabaseUrl(),
      redisUrl: this.resolveRedisUrl(),
    }
  }
  
  /**
   * Resolve state directory
   * Priority:
   * 1. TITANIUM_CLAWS_STATE_DIR
   * 2. OPENCLAW_STATE_DIR
   * 3. undefined (use default)
   */
  resolveStateDir(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_STATE_DIR`] ||
      process.env[`${this.legacy.envPrefix}_STATE_DIR`]
    )
  }
  
  /**
   * Resolve config path
   */
  resolveConfigPath(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_CONFIG_PATH`] ||
      process.env[`${this.legacy.envPrefix}_CONFIG_PATH`]
    )
  }
  
  /**
   * Resolve gateway token
   */
  resolveGatewayToken(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_GATEWAY_TOKEN`] ||
      process.env[`${this.legacy.envPrefix}_GATEWAY_TOKEN`]
    )
  }
  
  /**
   * Resolve gateway password
   */
  resolveGatewayPassword(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_GATEWAY_PASSWORD`] ||
      process.env[`${this.legacy.envPrefix}_GATEWAY_PASSWORD`]
    )
  }
  
  /**
   * Resolve log level
   */
  resolveLogLevel(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_LOG_LEVEL`] ||
      process.env[`${this.legacy.envPrefix}_LOG_LEVEL`]
    )
  }
  
  /**
   * Resolve database URL
   */
  resolveDatabaseUrl(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_DATABASE_URL`] ||
      process.env[`${this.legacy.envPrefix}_DATABASE_URL`]
    )
  }
  
  /**
   * Resolve Redis URL
   */
  resolveRedisUrl(): string | undefined {
    return (
      process.env[`${this.identity.envPrefix}_REDIS_URL`] ||
      process.env[`${this.legacy.envPrefix}_REDIS_URL`]
    )
  }
  
  /**
   * Get all Titanium Claws environment variables
   */
  getTitaniumClawsEnvVars(): Record<string, string | undefined> {
    const vars: Record<string, string | undefined> = {}
    const prefix = `${this.identity.envPrefix}_`
    
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix)) {
        vars[key] = value
      }
    }
    
    return vars
  }
  
  /**
   * Get all legacy OpenClaw environment variables
   */
  getLegacyEnvVars(): Record<string, string | undefined> {
    const vars: Record<string, string | undefined> = {}
    const prefix = `${this.legacy.envPrefix}_`
    
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix)) {
        vars[key] = value
      }
    }
    
    return vars
  }
  
  /**
   * Check if legacy environment variables are present
   */
  hasLegacyEnvVars(): boolean {
    return Object.keys(this.getLegacyEnvVars()).length > 0
  }
  
  /**
   * Validate environment configuration
   */
  validate(): EnvironmentValidationResult {
    const warnings: string[] = []
    const errors: string[] = []
    
    // Check for conflicting variables
    const stateDirNew = process.env[`${this.identity.envPrefix}_STATE_DIR`]
    const stateDirLegacy = process.env[`${this.legacy.envPrefix}_STATE_DIR`]
    
    if (stateDirNew && stateDirLegacy && stateDirNew !== stateDirLegacy) {
      errors.push(
        `Conflicting state directory: ` +
        `${this.identity.envPrefix}_STATE_DIR=${stateDirNew} vs ` +
        `${this.legacy.envPrefix}_STATE_DIR=${stateDirLegacy}`
      )
    }
    
    // Check for deprecated variables
    if (this.hasLegacyEnvVars()) {
      warnings.push(
        `Legacy OpenClaw environment variables detected. ` +
        `Consider migrating to ${this.identity.envPrefix}_* variables.`
      )
    }
    
    // Validate specific variables
    const gatewayToken = this.resolveGatewayToken()
    if (gatewayToken && gatewayToken.length < 32) {
      warnings.push(
        `Gateway token is less than 32 characters. ` +
        `Consider using a stronger token for security.`
      )
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    }
  }
  
  /**
   * Generate .env file template
   */
  generateEnvTemplate(): string {
    return `# Titanium Claws Configuration
# Generated: ${new Date().toISOString()}

# State directory (optional, defaults to ~/.titanium-claws)
${this.identity.envPrefix}_STATE_DIR=

# Configuration file path (optional, defaults to stateDir/titanium-claws.json)
${this.identity.envPrefix}_CONFIG_PATH=

# Gateway authentication token (required)
${this.identity.envPrefix}_GATEWAY_TOKEN=

# Log level (optional, defaults to "info")
# Options: debug, info, warn, error
${this.identity.envPrefix}_LOG_LEVEL=

# Database URL (optional, defaults to stateDir/titanium-claws.sqlite)
${this.identity.envPrefix}_DATABASE_URL=

# Redis URL (optional, for caching)
${this.identity.envPrefix}_REDIS_URL=

# ─── Legacy OpenClaw Variables (Deprecated) ──────────────────────────
# These variables are still supported but will emit warnings.
# Consider migrating to ${this.identity.envPrefix}_* variables.

# ${this.legacy.envPrefix}_STATE_DIR=
# ${this.legacy.envPrefix}_CONFIG_PATH=
# ${this.legacy.envPrefix}_GATEWAY_TOKEN=
# ${this.legacy.envPrefix}_LOG_LEVEL=
`
  }
  
  /**
   * Export environment for subprocess
   */
  exportForSubprocess(): Record<string, string> {
    const env: Record<string, string> = {}
    
    const stateDir = this.resolveStateDir()
    if (stateDir) {
      env[`${this.identity.envPrefix}_STATE_DIR`] = stateDir
    }
    
    const configPath = this.resolveConfigPath()
    if (configPath) {
      env[`${this.identity.envPrefix}_CONFIG_PATH`] = configPath
    }
    
    const gatewayToken = this.resolveGatewayToken()
    if (gatewayToken) {
      env[`${this.identity.envPrefix}_GATEWAY_TOKEN`] = gatewayToken
    }
    
    return env
  }
}

interface EnvironmentValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
```

---

## 4. Configuration Schema

### 4.1 Product Identity Configuration

```typescript
/**
 * Configuration file schema for product identity
 * Location: ~/.titanium-claws/titanium-claws.json
 */
export interface TitaniumClawsConfig {
  // Metadata
  version: string
  migratedFrom?: "openclaw"
  migratedAt?: string
  
  // Product identity (optional override)
  product?: Partial<ProductIdentity>
  
  // Paths (optional override)
  paths?: {
    stateDirectory?: string
    configPath?: string
    databasePath?: string
    logPath?: string
  }
  
  // Environment (optional override)
  environment?: {
    prefix?: string
    variables?: Record<string, string>
  }
  
  // Branding (optional override)
  branding?: {
    displayName?: string
    logo?: string
    colorScheme?: Partial<ColorScheme>
  }
  
  // Compatibility
  compatibility?: {
    openclawVersion?: string
    allowLegacyEnvVars?: boolean
    autoMigrate?: boolean
  }
  
  // Other configuration
  gateway?: GatewayConfig
  agents?: AgentsConfig
  memory?: MemoryConfig
  monitoring?: MonitoringConfig
}

interface GatewayConfig {
  port?: number
  host?: string
  auth?: {
    mode?: "token" | "password" | "none"
    token?: string
  }
  tls?: {
    enabled?: boolean
    cert?: string
    key?: string
  }
}

interface AgentsConfig {
  fleet?: {
    enabled?: boolean
    agents?: string[]
  }
  coordination?: {
    protocol?: "a2a" | "grpc" | "custom"
  }
}

interface MemoryConfig {
  backend?: "builtin" | "qmd"
  vector?: {
    engine?: "hnsw" | "flat"
    dimensions?: number
  }
  text?: {
    engine?: "tantivy" | "fts5"
    tokenizer?: string
  }
}

interface MonitoringConfig {
  enabled?: boolean
  metrics?: {
    prometheus?: {
      enabled?: boolean
      port?: number
    }
  }
  logging?: {
    level?: string
    format?: "json" | "text"
  }
}
```

### 4.2 Configuration Validation

```typescript
/**
 * Configuration validator
 */
export class ConfigValidator {
  /**
   * Validate configuration schema
   */
  validate(config: unknown): ConfigValidationResult {
    const errors: ValidationError[] = []
    
    // Type checks
    if (typeof config !== "object" || config === null) {
      errors.push({
        path: [],
        message: "Configuration must be an object"
      })
      return { valid: false, errors }
    }
    
    const typedConfig = config as TitaniumClawsConfig
    
    // Version validation
    if (!typedConfig.version) {
      errors.push({
        path: ["version"],
        message: "version is required"
      })
    } else if (!this.isValidSemver(typedConfig.version)) {
      errors.push({
        path: ["version"],
        message: `Invalid version format: ${typedConfig.version}`
      })
    }
    
    // Gateway validation
    if (typedConfig.gateway) {
      if (typedConfig.gateway.port !== undefined) {
        if (!this.isValidPort(typedConfig.gateway.port)) {
          errors.push({
            path: ["gateway", "port"],
            message: `Invalid port: ${typedConfig.gateway.port}`
          })
        }
      }
      
      if (typedConfig.gateway.auth?.mode === "token") {
        if (!typedConfig.gateway.auth.token) {
          errors.push({
            path: ["gateway", "auth", "token"],
            message: "Gateway token is required when auth mode is 'token'"
          })
        }
      }
    }
    
    // Memory validation
    if (typedConfig.memory) {
      if (typedConfig.memory.vector?.dimensions !== undefined) {
        if (typedConfig.memory.vector.dimensions < 1) {
          errors.push({
            path: ["memory", "vector", "dimensions"],
            message: "Vector dimensions must be positive"
          })
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    }
  }
  
  private isValidSemver(version: string): boolean {
    return /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)
  }
  
  private isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535
  }
}

interface ConfigValidationResult {
  valid: boolean
  errors: ValidationError[]
}

interface ValidationError {
  path: (string | number)[]
  message: string
}
```

---

## 5. Integration Examples

### 5.1 CLI Integration

```typescript
#!/usr/bin/env node
import { IdentityService } from "@titanium-claws/identity"
import { PRODUCT_IDENTITY, LEGACY_IDENTITY } from "./identity"

const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)

console.log(`${identity.getDisplayName()} v${identity.getVersion()}`)
console.log(identity.getTagline())

const command = process.argv[2]

if (command === "gateway") {
  const stateDir = identity.resolveStateDirectory()
  const configPath = identity.resolveConfigPath()
  
  console.log(`State Directory: ${stateDir}`)
  console.log(`Config Path: ${configPath}`)
  
  // Start gateway...
}

if (command === "--version") {
  console.log(identity.getVersion())
}

if (command === "--help") {
  console.log(`
Usage: ${identity.getExecutableName()} <command> [options]

Commands:
  gateway      Start the gateway
  agent        Manage agents
  workflow     Manage workflows
  doctor       Run diagnostics
  migrate      Migrate from OpenClaw

Options:
  --version    Show version
  --help       Show help

Documentation: ${identity.getDocsUrl()}
  `.trim())
}
```

### 5.2 Config Loader Integration

```typescript
import { IdentityService } from "@titanium-claws/identity"
import { ConfigLoader } from "@titanium-claws/config"

const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)

async function loadConfiguration(): Promise<TitaniumClawsConfig> {
  // Resolve config path (handles legacy fallback)
  const configPath = identity.resolveConfigPath()
  
  // Load configuration
  const loader = new ConfigLoader()
  const config = await loader.load(configPath)
  
  // Validate
  const validation = loader.validate(config)
  if (!validation.valid) {
    console.error("Configuration validation failed:")
    for (const error of validation.errors) {
      console.error(`  ${error.path.join(".")}: ${error.message}`)
    }
    process.exit(1)
  }
  
  return config
}
```

### 5.3 Logger Integration

```typescript
import { IdentityService } from "@titanium-claws/identity"

const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)

class Logger {
  private prefix: string
  
  constructor() {
    this.prefix = `[${identity.getDisplayName()}]`
  }
  
  info(message: string, ...args: unknown[]) {
    console.log(`${this.prefix} INFO: ${message}`, ...args)
  }
  
  warn(message: string, ...args: unknown[]) {
    console.warn(`${this.prefix} WARN: ${message}`, ...args)
  }
  
  error(message: string, ...args: unknown[]) {
    console.error(`${this.prefix} ERROR: ${message}`, ...args)
  }
}

const logger = new Logger()
logger.info("Starting gateway...")
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

```typescript
import { describe, it, expect } from "vitest"
import { IdentityService } from "../src/identity"
import { PRODUCT_IDENTITY, LEGACY_IDENTITY } from "../src/constants"

describe("IdentityService", () => {
  let identity: IdentityService
  
  beforeEach(() => {
    identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)
  })
  
  describe("getDisplayName", () => {
    it("should return product display name", () => {
      expect(identity.getDisplayName()).toBe("Titanium Claws")
    })
  })
  
  describe("getExecutableName", () => {
    it("should return short executable name by default", () => {
      expect(identity.getExecutableName()).toBe("tc")
    })
    
    it("should return full name when requested", () => {
      expect(identity.getExecutableName({ full: true })).toBe("titanium-claws")
    })
  })
  
  describe("resolveStateDirectory", () => {
    it("should resolve new state directory", () => {
      const path = identity.resolveStateDirectory()
      expect(path).toContain(".titanium-claws")
    })
    
    it("should fallback to legacy directory", () => {
      // Mock environment
      const originalHome = process.env.HOME
      process.env.HOME = "/tmp/test"
      
      // Create legacy directory
      fs.mkdirSync("/tmp/test/.openclaw", { recursive: true })
      
      const path = identity.resolveStateDirectory()
      expect(path).toBe("/tmp/test/.openclaw")
      
      // Cleanup
      fs.rmdirSync("/tmp/test/.openclaw")
      process.env.HOME = originalHome
    })
  })
  
  describe("validate", () => {
    it("should validate correct identity", () => {
      const result = identity.validate()
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })
  })
})
```

### 6.2 Integration Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { IdentityService } from "../src/identity"
import { ConfigLoader } from "../src/config"

describe("Identity Integration", () => {
  let testDir: string
  
  beforeAll(async () => {
    testDir = await fs.promises.mkdtemp("/tmp/titanium-claws-test-")
  })
  
  afterAll(async () => {
    await fs.promises.rm(testDir, { recursive: true })
  })
  
  it("should load configuration with identity", async () => {
    const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)
    
    // Create test config
    const configPath = path.join(testDir, "titanium-claws.json")
    await fs.promises.writeFile(configPath, JSON.stringify({
      version: "1.0.0",
      gateway: {
        port: 18789
      }
    }))
    
    // Load with identity
    const loader = new ConfigLoader(identity)
    const config = await loader.load(configPath)
    
    expect(config.version).toBe("1.0.0")
    expect(config.gateway?.port).toBe(18789)
  })
})
```

---

## 7. Migration Path

### 7.1 From Hardcoded Strings

**Before:**
```typescript
console.log("Starting OpenClaw...")
const configPath = "~/.openclaw/openclaw.json"
const token = process.env.OPENCLAW_GATEWAY_TOKEN
```

**After:**
```typescript
const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)
console.log(`Starting ${identity.getDisplayName()}...`)
const configPath = identity.resolveConfigPath()
const token = identity.resolveGatewayToken()
```

### 7.2 Migration Checklist

- [ ] Replace hardcoded product names with `IdentityService`
- [ ] Replace hardcoded paths with `PathResolver`
- [ ] Replace environment variable access with `EnvironmentResolver`
- [ ] Update CLI to use identity service
- [ ] Update logger to use identity service
- [ ] Update metrics to use identity service
- [ ] Update UI to use identity service
- [ ] Test backward compatibility with OpenClaw
- [ ] Update documentation
- [ ] Create migration guide

---

## 8. Future Enhancements

### 8.1 Plugin Identity

Allow plugins to define their own identity:

```typescript
export interface PluginIdentity {
  name: string
  version: string
  displayName?: string
  description?: string
  author?: string
  license?: string
}
```

### 8.2 Multi-Product Support

Support running multiple products from same codebase:

```typescript
export class MultiProductManager {
  private products: Map<string, IdentityService>
  
  registerProduct(name: string, identity: ProductIdentity) {
    this.products.set(name, new IdentityService(identity, LEGACY_IDENTITY))
  }
  
  getProduct(name: string): IdentityService {
    const product = this.products.get(name)
    if (!product) {
      throw new Error(`Product not found: ${name}`)
    }
    return product
  }
}
```

### 8.3 Dynamic Branding

Support runtime branding changes:

```typescript
export class DynamicBranding {
  private currentTheme: "light" | "dark"
  
  setTheme(theme: "light" | "dark") {
    this.currentTheme = theme
    this.emit("theme-changed", theme)
  }
  
  getLogo(): string {
    return identity.getLogoPath(this.currentTheme)
  }
}
```

---

## 9. Conclusion

The Identity Layer provides a robust, centralized system for managing product identity in Titanium Claws. By abstracting all branding, paths, and environment variables into a single service, we achieve:

1. **Maintainability**: Single source of truth for all identity
2. **Flexibility**: Easy to rebrand or customize
3. **Compatibility**: Seamless fallback to OpenClaw
4. **Testability**: Isolated, testable components
5. **Type Safety**: Full TypeScript type checking

This foundation enables all subsequent migration work and ensures a consistent user experience across the entire product.

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Identity Layer** | Centralized system for managing product identity |
| **Identity Service** | Public API for accessing identity information |
| **Path Resolver** | Component that resolves filesystem paths |
| **Environment Resolver** | Component that resolves environment variables |
| **Compatibility Layer** | Logic for backward compatibility with OpenClaw |
| **Legacy Identity** | OpenClaw identity for fallback support |

## Appendix B: Related Documents

- `01-ARCHITECTURE-RFC.md` - Overall architecture
- `03-MIGRATION-SPEC.md` - Migration specification
- `04-RELEASE-ENGINEERING-SPEC.md` - Release engineering

## Appendix C: Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-21 | Titanium Claws Team | Initial draft |
