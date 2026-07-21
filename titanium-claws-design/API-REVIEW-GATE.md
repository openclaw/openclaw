# Titanium Claws - API Review Gate & Design Rules

**Status**: DRAFT - PENDING APPROVAL  
**Version**: 1.0.0  
**Created**: 2026-07-21  
**Purpose**: Freeze public contracts and establish design rules before implementation

---

## Executive Summary

This document defines the **frozen public API contracts** and **architectural design rules** for the Titanium Claws Identity Layer. Once approved, these contracts become stable and implementation can proceed with confidence that the public surface will not change.

### What This Document Contains

1. **Public API Contracts** (Part 1) - Exact type signatures, behavior, and guarantees
2. **Design Rules** (Part 2) - Architectural constraints and dependency policies
3. **Implementation Strategy** (Part 3) - Vertical slices and validation approach
4. **Approval Checklist** (Part 4) - Criteria for signing off on this gate

### What This Document Does NOT Contain

- Implementation details (internal code structure)
- Performance characteristics (can evolve)
- Internal algorithms (can be optimized)
- File organization (can be refactored)

**The implementation is free to evolve as long as these public contracts remain stable.**

---

## Part 1: Public API Contracts

### 1.1 PRODUCT_IDENTITY Constant

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED within major version  
**Breaking Changes**: Only in major version bumps

```typescript
/**
 * Complete product identity definition.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const PRODUCT_IDENTITY: Readonly<ProductIdentity> = {
  // ─── Public Identity ────────────────────────────────────────────
  displayName: "Titanium Claws",
  shortName: "Titanium",
  tagline: "Rust-Powered Multi-Agent Intelligence",
  description: "High-performance, multi-agent AI system with Rust-native engines",
  
  // ─── Technical Identity ─────────────────────────────────────────
  executable: "tc",
  executableFull: "titanium-claws",
  packageScope: "@titanium-claws",
  repository: "titanium-claws/titanium-claws",
  
  // ─── Configuration ──────────────────────────────────────────────
  stateDirectory: ".titanium-claws",
  configFile: "titanium-claws.json",
  databaseFile: "titanium-claws.sqlite",
  logFile: "titanium-claws.log",
  envPrefix: "TITANIUM_CLAWS",
  
  // ─── Versioning ─────────────────────────────────────────────────
  version: "1.0.0",
  openclawCompatibility: "2026.7.2",
  protocolVersion: "1.0.0",
  
  // ─── Branding ───────────────────────────────────────────────────
  branding: {
    logo: {
      light: "assets/logos/titanium-claws-light.svg",
      dark: "assets/logos/titanium-claws-dark.svg",
      icon: "assets/logos/titanium-claws-icon.svg",
    },
    colors: {
      primary: "#4A5568",      // Titanium Gray
      secondary: "#2C5282",    // Steel Blue
      accent: "#E53E3E",       // Lobster Red
      success: "#38A169",      // Performance Green
      warning: "#D69E2E",      // Benchmark Yellow
      error: "#C53030",        // Critical Red
    },
    typography: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontFamilyMono: "JetBrains Mono, monospace",
    },
  },
  
  // ─── Documentation ──────────────────────────────────────────────
  urls: {
    website: "https://titaniumclaws.ai",
    docs: "https://docs.titaniumclaws.ai",
    repository: "https://github.com/titanium-claws/titanium-claws",
    issues: "https://github.com/titanium-claws/titanium-claws/issues",
    support: "mailto:support@titaniumclaws.ai",
  },
  
  // ─── Legal ──────────────────────────────────────────────────────
  legal: {
    license: "MIT",
    copyright: "© 2026 Titanium Claws Contributors",
    privacy: "https://titaniumclaws.ai/privacy",
    terms: "https://titaniumclaws.ai/terms",
  },
} as const;
```

**Contract Guarantees:**
- ✅ All fields are `readonly` and cannot be modified at runtime
- ✅ String values follow the specified formats
- ✅ Version fields follow semantic versioning
- ✅ URL fields are valid URLs
- ✅ Color values are valid hex colors

**Change Policy:**
- Adding new fields: ✅ Allowed (minor version)
- Removing fields: ❌ Forbidden (breaking change)
- Modifying field types: ❌ Forbidden (breaking change)
- Modifying field values: ⚠️ Allowed with deprecation notice (major version)

---

### 1.2 LEGACY_IDENTITY Constant

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED - Never changes  
**Purpose**: Backward compatibility with OpenClaw

```typescript
/**
 * Legacy OpenClaw identity for backward compatibility.
 * 
 * @stability Stable
 * @deprecated Use PRODUCT_IDENTITY for new code
 * @version 1.0.0
 * @since 1.0.0
 */
export const LEGACY_IDENTITY: Readonly<LegacyIdentity> = {
  displayName: "OpenClaw",
  shortName: "OpenClaw",
  tagline: "Personal AI Assistant",
  description: "Open-source AI agent framework",
  
  executable: "openclaw",
  executableFull: "openclaw",
  packageScope: "@openclaw",
  repository: "openclaw/openclaw",
  
  stateDirectory: ".openclaw",
  configFile: "openclaw.json",
  databaseFile: "openclaw.sqlite",
  logFile: "openclaw.log",
  envPrefix: "OPENCLAW",
  
  version: "2026.7.2",
  openclawCompatibility: "2026.7.2",
  protocolVersion: "1.0.0",
  
  branding: {
    logo: {
      light: "assets/logos/openclaw-light.svg",
      dark: "assets/logos/openclaw-dark.svg",
      icon: "assets/logos/openclaw-icon.svg",
    },
    colors: {
      primary: "#1A202C",
      secondary: "#2D3748",
      accent: "#E53E3E",
      success: "#38A169",
      warning: "#D69E2E",
      error: "#C53030",
    },
    typography: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontFamilyMono: "JetBrains Mono, monospace",
    },
  },
  
  urls: {
    website: "https://openclaw.ai",
    docs: "https://docs.openclaw.ai",
    repository: "https://github.com/openclaw/openclaw",
    issues: "https://github.com/openclaw/openclaw/issues",
    support: "mailto:support@openclaw.ai",
  },
  
  legal: {
    license: "MIT",
    copyright: "© 2026 OpenClaw Contributors",
    privacy: "https://openclaw.ai/privacy",
    terms: "https://openclaw.ai/terms",
  },
} as const;
```

**Contract Guarantees:**
- ✅ This constant will NEVER change
- ✅ Values match the actual OpenClaw project
- ✅ Used only for backward compatibility resolution

**Change Policy:**
- Any changes: ❌ Forbidden (would break compatibility)

---

### 1.3 IdentityService Interface

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED within major version  
**Breaking Changes**: Only in major version bumps

```typescript
/**
 * Public API for accessing product identity.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface IIdentityService {
  // ─── Public Identity ────────────────────────────────────────────
  
  /**
   * Get full product display name.
   * @returns "Titanium Claws"
   */
  getDisplayName(): string;
  
  /**
   * Get short product name.
   * @returns "Titanium"
   */
  getShortName(): string;
  
  /**
   * Get product tagline.
   * @returns "Rust-Powered Multi-Agent Intelligence"
   */
  getTagline(): string;
  
  /**
   * Get full product description.
   */
  getDescription(): string;
  
  // ─── Technical Identity ─────────────────────────────────────────
  
  /**
   * Get CLI executable name.
   * @param options.full - Use full name instead of short name
   * @returns "tc" or "titanium-claws"
   */
  getExecutableName(options?: { full?: boolean }): string;
  
  /**
   * Get NPM package scope.
   * @returns "@titanium-claws"
   */
  getPackageScope(): string;
  
  /**
   * Get repository identifier.
   * @returns "titanium-claws/titanium-claws"
   */
  getRepository(): string;
  
  // ─── Configuration ──────────────────────────────────────────────
  
  /**
   * Get state directory name.
   * @returns ".titanium-claws"
   */
  getStateDirectoryName(): string;
  
  /**
   * Get config file name.
   * @returns "titanium-claws.json"
   */
  getConfigFileName(): string;
  
  /**
   * Get environment variable prefix.
   * @returns "TITANIUM_CLAWS"
   */
  getEnvPrefix(): string;
  
  // ─── Versioning ─────────────────────────────────────────────────
  
  /**
   * Get product version.
   * @returns "1.0.0"
   */
  getVersion(): string;
  
  /**
   * Get OpenClaw compatibility version.
   * @returns "2026.7.2"
   */
  getOpenClawCompatibilityVersion(): string;
  
  /**
   * Check compatibility with OpenClaw version.
   */
  isCompatibleWithOpenClaw(version: string): boolean;
  
  // ─── Branding ───────────────────────────────────────────────────
  
  /**
   * Get logo path.
   */
  getLogoPath(theme?: "light" | "dark"): string;
  
  /**
   * Get color scheme.
   */
  getColorScheme(): ColorScheme;
  
  /**
   * Get typography configuration.
   */
  getTypography(): Typography;
  
  // ─── Documentation ──────────────────────────────────────────────
  
  /**
   * Get website URL.
   */
  getWebsiteUrl(): string;
  
  /**
   * Get documentation URL.
   */
  getDocsUrl(): string;
  
  /**
   * Get repository URL.
   */
  getRepositoryUrl(): string;
  
  /**
   * Get support email.
   */
  getSupportEmail(): string;
  
  // ─── Legal ──────────────────────────────────────────────────────
  
  /**
   * Get license type.
   */
  getLicense(): string;
  
  /**
   * Get copyright notice.
   */
  getCopyright(): string;
  
  // ─── Legacy Compatibility ───────────────────────────────────────
  
  /**
   * Get legacy OpenClaw executable name.
   * @returns "openclaw"
   */
  getLegacyExecutableName(): string;
  
  /**
   * Get legacy package scope.
   * @returns "@openclaw"
   */
  getLegacyPackageScope(): string;
  
  /**
   * Get legacy state directory.
   * @returns ".openclaw"
   */
  getLegacyStateDirectoryName(): string;
  
  /**
   * Get legacy environment prefix.
   * @returns "OPENCLAW"
   */
  getLegacyEnvPrefix(): string;
  
  // ─── Path Resolution ────────────────────────────────────────────
  
  /**
   * Resolve all filesystem paths.
   */
  resolvePaths(): ResolvedPaths;
  
  /**
   * Resolve state directory path.
   */
  resolveStateDirectory(): string;
  
  /**
   * Resolve config file path.
   */
  resolveConfigPath(): string;
  
  /**
   * Resolve database path.
   */
  resolveDatabasePath(): string;
  
  /**
   * Resolve log file path.
   */
  resolveLogPath(): string;
  
  // ─── Environment Resolution ─────────────────────────────────────
  
  /**
   * Resolve all environment variables.
   */
  resolveEnvironment(): ResolvedEnvironment;
  
  /**
   * Resolve state directory from environment.
   */
  resolveStateDir(): string | undefined;
  
  /**
   * Resolve config path from environment.
   */
  resolveConfigPath(): string | undefined;
  
  /**
   * Resolve gateway token from environment.
   */
  resolveGatewayToken(): string | undefined;
  
  // ─── Utility Methods ────────────────────────────────────────────
  
  /**
   * Get complete identity object.
   */
  getIdentity(): ProductIdentity;
  
  /**
   * Format identity for display.
   */
  formatForDisplay(): string;
  
  /**
   * Export identity as JSON.
   */
  exportAsJson(): string;
  
  /**
   * Validate identity configuration.
   */
  validate(): ValidationResult;
}

/**
 * Factory function for creating IdentityService instances.
 */
export function createIdentityService(
  identity: ProductIdentity = PRODUCT_IDENTITY,
  legacy: LegacyIdentity = LEGACY_IDENTITY
): IIdentityService;
```

**Contract Guarantees:**
- ✅ All method signatures remain stable
- ✅ Return types remain stable
- ✅ Method behavior remains stable
- ✅ No methods are removed
- ✅ New methods may be added (minor version)

**Change Policy:**
- Adding methods: ✅ Allowed (minor version)
- Removing methods: ❌ Forbidden (breaking change)
- Changing signatures: ❌ Forbidden (breaking change)
- Changing return types: ❌ Forbidden (breaking change)
- Deprecating methods: ⚠️ Allowed with 2-major-version notice

---

### 1.4 PathResolver Interface

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED within major version  
**Breaking Changes**: Only in major version bumps

```typescript
/**
 * Resolves filesystem paths with backward compatibility.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface IPathResolver {
  /**
   * Resolve all paths.
   */
  resolve(): ResolvedPaths;
  
  /**
   * Resolve state directory.
   * 
   * Priority:
   * 1. Environment variable (TITANIUM_CLAWS_STATE_DIR)
   * 2. New path (~/.titanium-claws)
   * 3. Legacy path (~/.openclaw)
   */
  resolveStateDirectory(): string;
  
  /**
   * Resolve config file path.
   */
  resolveConfigPath(): string;
  
  /**
   * Resolve database path.
   */
  resolveDatabasePath(): string;
  
  /**
   * Resolve log file path.
   */
  resolveLogPath(): string;
  
  /**
   * Resolve cache directory.
   */
  resolveCachePath(): string;
  
  /**
   * Resolve temporary directory.
   */
  resolveTempPath(): string;
  
  /**
   * Resolve plugins directory.
   */
  resolvePluginsPath(): string;
  
  /**
   * Resolve workspace directory.
   */
  resolveWorkspacePath(): string;
  
  /**
   * Get legacy paths for migration.
   */
  getLegacyPaths(): LegacyPaths;
  
  /**
   * Check if legacy paths exist.
   */
  legacyPathsExist(): boolean;
  
  /**
   * Ensure all directories exist.
   */
  ensureDirectories(): Promise<void>;
}

/**
 * Resolved filesystem paths.
 */
export interface ResolvedPaths {
  stateDirectory: string;
  configPath: string;
  databasePath: string;
  logPath: string;
  cachePath: string;
  tempPath: string;
  pluginsPath: string;
  workspacePath: string;
}

/**
 * Legacy paths for fallback.
 */
export interface LegacyPaths {
  stateDirectory: string;
  configPath: string;
  databasePath: string;
  logPath: string;
}
```

**Contract Guarantees:**
- ✅ All method signatures remain stable
- ✅ Path resolution logic remains stable
- ✅ Fallback order remains stable
- ✅ Legacy path detection remains stable

**Change Policy:**
- Adding methods: ✅ Allowed (minor version)
- Removing methods: ❌ Forbidden (breaking change)
- Changing resolution logic: ⚠️ Allowed with deprecation notice (major version)
- Changing fallback order: ❌ Forbidden (breaking change)

---

### 1.5 EnvironmentResolver Interface

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED within major version  
**Breaking Changes**: Only in major version bumps

```typescript
/**
 * Resolves environment variables with backward compatibility.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface IEnvironmentResolver {
  /**
   * Resolve all environment variables.
   */
  resolve(): ResolvedEnvironment;
  
  /**
   * Resolve state directory.
   * 
   * Priority:
   * 1. TITANIUM_CLAWS_STATE_DIR
   * 2. OPENCLAW_STATE_DIR
   * 3. undefined (use default)
   */
  resolveStateDir(): string | undefined;
  
  /**
   * Resolve config path.
   */
  resolveConfigPath(): string | undefined;
  
  /**
   * Resolve gateway token.
   */
  resolveGatewayToken(): string | undefined;
  
  /**
   * Resolve gateway password.
   */
  resolveGatewayPassword(): string | undefined;
  
  /**
   * Resolve log level.
   */
  resolveLogLevel(): string | undefined;
  
  /**
   * Resolve database URL.
   */
  resolveDatabaseUrl(): string | undefined;
  
  /**
   * Resolve Redis URL.
   */
  resolveRedisUrl(): string | undefined;
  
  /**
   * Get all Titanium Claws environment variables.
   */
  getTitaniumClawsEnvVars(): Record<string, string | undefined>;
  
  /**
   * Get all legacy OpenClaw environment variables.
   */
  getLegacyEnvVars(): Record<string, string | undefined>;
  
  /**
   * Check if legacy environment variables are present.
   */
  hasLegacyEnvVars(): boolean;
  
  /**
   * Validate environment configuration.
   */
  validate(): EnvironmentValidationResult;
  
  /**
   * Generate .env file template.
   */
  generateEnvTemplate(): string;
  
  /**
   * Export environment for subprocess.
   */
  exportForSubprocess(): Record<string, string>;
}

/**
 * Resolved environment variables.
 */
export interface ResolvedEnvironment {
  stateDir: string | undefined;
  configPath: string | undefined;
  gatewayToken: string | undefined;
  gatewayPassword: string | undefined;
  logLevel: string | undefined;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
}

/**
 * Environment validation result.
 */
export interface EnvironmentValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

**Contract Guarantees:**
- ✅ All method signatures remain stable
- ✅ Resolution priority remains stable
- ✅ Validation logic remains stable
- ✅ Legacy variable detection remains stable

**Change Policy:**
- Adding methods: ✅ Allowed (minor version)
- Removing methods: ❌ Forbidden (breaking change)
- Changing resolution priority: ❌ Forbidden (breaking change)
- Adding new environment variables: ✅ Allowed (minor version)

---

### 1.6 Configuration Schema

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED within major version  
**Breaking Changes**: Only in major version bumps

```typescript
/**
 * Titanium Claws configuration file schema.
 * Location: ~/.titanium-claws/titanium-claws.json
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface TitaniumClawsConfig {
  /**
   * Configuration schema version.
   * Required field.
   */
  version: string;
  
  /**
   * Migration metadata.
   * Optional, added by migration tool.
   */
  _migration?: {
    from: "openclaw";
    to: "titanium-claws";
    migratedAt: string;
    version: string;
  };
  
  /**
   * Product identity override.
   * Optional, for custom branding.
   */
  product?: Partial<ProductIdentity>;
  
  /**
   * Path overrides.
   * Optional, for custom paths.
   */
  paths?: {
    stateDirectory?: string;
    configPath?: string;
    databasePath?: string;
    logPath?: string;
  };
  
  /**
   * Environment variable configuration.
   * Optional.
   */
  environment?: {
    prefix?: string;
    variables?: Record<string, string>;
  };
  
  /**
   * Branding overrides.
   * Optional.
   */
  branding?: {
    displayName?: string;
    logo?: string;
    colorScheme?: Partial<ColorScheme>;
  };
  
  /**
   * Compatibility settings.
   * Optional.
   */
  compatibility?: {
    openclawVersion?: string;
    allowLegacyEnvVars?: boolean;
    autoMigrate?: boolean;
  };
  
  /**
   * Gateway configuration.
   * Optional.
   */
  gateway?: GatewayConfig;
  
  /**
   * Agents configuration.
   * Optional.
   */
  agents?: AgentsConfig;
  
  /**
   * Memory configuration.
   * Optional.
   */
  memory?: MemoryConfig;
  
  /**
   * Monitoring configuration.
   * Optional.
   */
  monitoring?: MonitoringConfig;
}

interface GatewayConfig {
  port?: number;
  host?: string;
  auth?: {
    mode?: "token" | "password" | "none";
    token?: string;
  };
  tls?: {
    enabled?: boolean;
    cert?: string;
    key?: string;
  };
}

interface AgentsConfig {
  fleet?: {
    enabled?: boolean;
    agents?: string[];
  };
  coordination?: {
    protocol?: "a2a" | "grpc" | "custom";
  };
}

interface MemoryConfig {
  backend?: "builtin" | "qmd";
  vector?: {
    engine?: "hnsw" | "flat";
    dimensions?: number;
  };
  text?: {
    engine?: "tantivy" | "fts5";
    tokenizer?: string;
  };
}

interface MonitoringConfig {
  enabled?: boolean;
  metrics?: {
    prometheus?: {
      enabled?: boolean;
      port?: number;
    };
  };
  logging?: {
    level?: string;
    format?: "json" | "text";
  };
}

interface ColorScheme {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  background: string;
  text: string;
}
```

**Contract Guarantees:**
- ✅ `version` field is always required
- ✅ All fields follow specified types
- ✅ Unknown fields are ignored (forward compatibility)
- ✅ Schema validation is deterministic

**Change Policy:**
- Adding optional fields: ✅ Allowed (minor version)
- Removing fields: ❌ Forbidden (breaking change)
- Changing field types: ❌ Forbidden (breaking change)
- Making optional fields required: ❌ Forbidden (breaking change)

---

### 1.7 Error Model

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED within major version  
**Breaking Changes**: Only in major version bumps

```typescript
/**
 * Base error class for Identity Layer errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class IdentityError extends Error {
  constructor(
    message: string,
    public readonly code: IdentityErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

/**
 * Error codes for Identity Layer.
 */
export enum IdentityErrorCode {
  // Configuration errors
  INVALID_CONFIG = "INVALID_CONFIG",
  MISSING_VERSION = "MISSING_VERSION",
  INVALID_VERSION = "INVALID_VERSION",
  
  // Path resolution errors
  PATH_NOT_FOUND = "PATH_NOT_FOUND",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  
  // Environment errors
  INVALID_ENV_VAR = "INVALID_ENV_VAR",
  CONFLICTING_ENV_VARS = "CONFLICTING_ENV_VARS",
  
  // Validation errors
  VALIDATION_FAILED = "VALIDATION_FAILED",
  
  // Migration errors
  MIGRATION_FAILED = "MIGRATION_FAILED",
  ROLLBACK_FAILED = "ROLLBACK_FAILED",
}

/**
 * Validation result interface.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validation error details.
 */
export interface ValidationError {
  path: (string | number)[];
  message: string;
  code?: string;
}
```

**Contract Guarantees:**
- ✅ Error class hierarchy remains stable
- ✅ Error codes remain stable
- ✅ Error properties remain stable

**Change Policy:**
- Adding error codes: ✅ Allowed (minor version)
- Removing error codes: ❌ Forbidden (breaking change)
- Changing error properties: ❌ Forbidden (breaking change)

---

### 1.8 Versioning Policy

**Status**: 🟡 PENDING APPROVAL  
**Stability**: GUARANTEED  
**Breaking Changes**: Never

```typescript
/**
 * Version compatibility checking.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class VersioningPolicy {
  /**
   * Check if two versions are compatible.
   */
  static isCompatible(current: string, target: string): boolean {
    const currentParts = this.parse(current);
    const targetParts = this.parse(target);
    
    // Major version must match
    return currentParts.major === targetParts.major;
  }
  
  /**
   * Check if current version satisfies requirement.
   */
  static satisfies(current: string, requirement: string): boolean {
    const currentParts = this.parse(current);
    const reqParts = this.parse(requirement);
    
    if (currentParts.major !== reqParts.major) {
      return false;
    }
    
    if (currentParts.minor < reqParts.minor) {
      return false;
    }
    
    if (currentParts.minor === reqParts.minor && currentParts.patch < reqParts.patch) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Parse version string.
   */
  static parse(version: string): { major: number; minor: number; patch: number } {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      throw new IdentityError(
        `Invalid version format: ${version}`,
        IdentityErrorCode.INVALID_VERSION
      );
    }
    
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
    };
  }
}
```

**Contract Guarantees:**
- ✅ Semantic versioning is always followed
- ✅ Major version indicates breaking changes
- ✅ Minor version indicates new features
- ✅ Patch version indicates bug fixes

**Change Policy:**
- Version format: ❌ Never changes
- Compatibility rules: ❌ Never changes

---

## Part 2: Design Rules

### 2.1 Architectural Constraints

**Status**: 🟡 PENDING APPROVAL  
**Enforcement**: Mandatory

#### Rule 1: No Hardcoded Product Strings

```typescript
// ❌ FORBIDDEN
const name = "OpenClaw";
const path = "~/.openclaw";
const envVar = "OPENCLAW_GATEWAY_TOKEN";

// ✅ REQUIRED
const identity = createIdentityService();
const name = identity.getDisplayName();
const path = identity.resolveStateDirectory();
const envVar = `${identity.getEnvPrefix()}_GATEWAY_TOKEN`;
```

**Rationale**: Enables single-point branding changes and ensures consistency.

**Exceptions**: None.

---

#### Rule 2: No Direct `process.env` Access

```typescript
// ❌ FORBIDDEN
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

// ✅ REQUIRED
const resolver = createEnvironmentResolver();
const token = resolver.resolveGatewayToken();
```

**Rationale**: Centralizes environment resolution and enables dual-read support.

**Exceptions**: Only in `EnvironmentResolver` implementation itself.

---

#### Rule 3: No Direct Filesystem Path Construction

```typescript
// ❌ FORBIDDEN
const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");

// ✅ REQUIRED
const resolver = createPathResolver();
const configPath = resolver.resolveConfigPath();
```

**Rationale**: Centralizes path resolution and enables fallback logic.

**Exceptions**: Only in `PathResolver` implementation itself.

---

#### Rule 4: Public Interfaces Must Remain Backward Compatible

```typescript
// ❌ FORBIDDEN (breaking change)
interface IdentityService {
  getName(): string;  // Renamed from getDisplayName()
}

// ✅ REQUIRED
interface IdentityService {
  getDisplayName(): string;  // Original method preserved
  getName(): string;         // New method added (alias)
}
```

**Rationale**: Prevents breaking existing users.

**Exceptions**: Only in major version bumps with migration guide.

---

#### Rule 5: Every Public Type Must Have Documentation

```typescript
// ❌ FORBIDDEN
interface ProductIdentity {
  displayName: string;
}

// ✅ REQUIRED
/**
 * Complete product identity definition.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
interface ProductIdentity {
  /**
   * Full product display name.
   * @returns "Titanium Claws"
   */
  displayName: string;
}
```

**Rationale**: Ensures API clarity and enables documentation generation.

**Exceptions**: None.

---

#### Rule 6: Every Public Type Must Have Tests

```typescript
// ❌ FORBIDDEN
export interface IdentityService {
  getDisplayName(): string;
}

// ✅ REQUIRED
export interface IdentityService {
  getDisplayName(): string;
}

// test/identity/identity-service.test.ts
describe("IdentityService", () => {
  describe("getDisplayName", () => {
    it("should return product display name", () => {
      const service = createIdentityService();
      expect(service.getDisplayName()).toBe("Titanium Claws");
    });
  });
});
```

**Rationale**: Ensures API correctness and prevents regressions.

**Exceptions**: None.

---

### 2.2 Brand vs Identity Separation

**Status**: 🟡 PENDING APPROVAL  
**Structure**: Mandatory

```typescript
/**
 * Identity Layer - Operational identity
 * 
 * Manages:
 * - Product metadata (name, version, executable)
 * - Configuration paths
 * - Environment variables
 * - Filesystem paths
 * - Versioning
 * - Compatibility
 */
export namespace Identity {
  export const PRODUCT_IDENTITY: ProductIdentity;
  export const LEGACY_IDENTITY: LegacyIdentity;
  export function createIdentityService(): IIdentityService;
  export function createPathResolver(): IPathResolver;
  export function createEnvironmentResolver(): IEnvironmentResolver;
}

/**
 * Brand Layer - Visual identity
 * 
 * Manages:
 * - Display strings (marketing copy)
 * - Logos and icons
 * - CLI banners and ASCII art
 * - Documentation metadata
 * - URLs and links
 * - Color schemes
 * - Typography
 */
export namespace Brand {
  export function getDisplayStrings(): DisplayStrings;
  export function getLogoPath(theme: "light" | "dark"): string;
  export function getCLIBanner(): string;
  export function getDocumentationMetadata(): DocumentationMetadata;
  export function getURLs(): URLs;
}
```

**Rationale**: Separates operational concerns (Identity) from marketing concerns (Brand). Enables independent evolution of technical and visual identity.

**Change Policy:**
- Identity changes: Require careful review (affects runtime behavior)
- Brand changes: Can be made freely (affects only presentation)

---

### 2.3 Dependency Rules

**Status**: 🟡 PENDING APPROVAL  
**Enforcement**: Mandatory

```
Dependency Graph:

┌─────────────────────────────────────────┐
│  Application Layer                       │
│  - CLI commands                          │
│  - Gateway server                        │
│  - Agent runtime                         │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Identity Layer                          │
│  - IdentityService                       │
│  - PathResolver                          │
│  - EnvironmentResolver                   │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Constants Layer                         │
│  - PRODUCT_IDENTITY                      │
│  - LEGACY_IDENTITY                       │
│  - Error codes                           │
└─────────────────────────────────────────┘
```

**Rules:**
1. Application Layer can depend on Identity Layer
2. Identity Layer can depend on Constants Layer
3. Constants Layer cannot depend on anything
4. No circular dependencies allowed
5. No dependencies on implementation details

**Enforcement:**
- ESLint rules to prevent forbidden imports
- Architectural tests to validate dependency graph
- Code review to catch violations

---

## Part 3: Implementation Strategy

### 3.1 Vertical Slices

**Status**: 🟡 PENDING APPROVAL  
**Order**: Sequential (each slice must be complete before starting next)

#### Slice 1: Constants & Types

**Deliverables:**
- `src/identity/constants.ts` - PRODUCT_IDENTITY, LEGACY_IDENTITY
- `src/identity/types.ts` - All TypeScript interfaces
- `src/identity/errors.ts` - Error classes and codes
- `test/identity/constants.test.ts` - Tests
- `test/identity/types.test.ts` - Tests

**Success Criteria:**
- ✅ All constants defined and exported
- ✅ All types defined and exported
- ✅ All error codes defined and exported
- ✅ Unit tests pass
- ✅ Type checking passes
- ✅ Documentation complete

**Estimated Effort**: 4-6 hours

---

#### Slice 2: IdentityService

**Deliverables:**
- `src/identity/identity-service.ts` - IdentityService implementation
- `src/identity/factory.ts` - Factory functions
- `test/identity/identity-service.test.ts` - Tests
- `docs/identity/identity-service.md` - Documentation

**Success Criteria:**
- ✅ IdentityService implements IIdentityService interface
- ✅ All methods implemented
- ✅ Unit tests pass (>90% coverage)
- ✅ Integration tests pass
- ✅ Documentation complete

**Estimated Effort**: 6-8 hours

---

#### Slice 3: PathResolver

**Deliverables:**
- `src/identity/path-resolver.ts` - PathResolver implementation
- `test/identity/path-resolver.test.ts` - Tests
- `docs/identity/path-resolver.md` - Documentation

**Success Criteria:**
- ✅ PathResolver implements IPathResolver interface
- ✅ Fallback logic works correctly
- ✅ Legacy path detection works
- ✅ Unit tests pass (>90% coverage)
- ✅ Integration tests with existing OpenClaw config pass
- ✅ Documentation complete

**Estimated Effort**: 6-8 hours

---

#### Slice 4: EnvironmentResolver

**Deliverables:**
- `src/identity/environment-resolver.ts` - EnvironmentResolver implementation
- `test/identity/environment-resolver.test.ts` - Tests
- `docs/identity/environment-resolver.md` - Documentation

**Success Criteria:**
- ✅ EnvironmentResolver implements IEnvironmentResolver interface
- ✅ Dual resolution works (new + legacy)
- ✅ Deprecation warnings emitted for legacy vars
- ✅ Unit tests pass (>90% coverage)
- ✅ Integration tests pass
- ✅ Documentation complete

**Estimated Effort**: 6-8 hours

---

#### Slice 5: Integration & Validation

**Deliverables:**
- `src/identity/index.ts` - Public API exports
- `test/identity/integration.test.ts` - Integration tests
- `docs/identity/README.md` - Usage guide
- `docs/identity/migration.md` - Migration guide

**Success Criteria:**
- ✅ Public API exports all components
- ✅ Integration tests pass
- ✅ Usage guide complete
- ✅ Migration guide complete
- ✅ All documentation linked

**Estimated Effort**: 4-6 hours

---

**Total Estimated Effort**: 26-36 hours (approximately 1 week)

---

### 3.2 Pilot Migration

**Status**: 🟡 PENDING APPROVAL  
**Target**: CLI startup or configuration loader

**Steps:**
1. Identify 10-20 hardcoded "OpenClaw" references in CLI startup
2. Refactor to use IdentityService
3. Verify backward compatibility (both `openclaw` and `tc` commands work)
4. Run existing test suite
5. Document any issues or edge cases

**Success Criteria:**
- ✅ No hardcoded "OpenClaw" strings in target area
- ✅ Backward compatibility maintained
- ✅ All existing tests pass
- ✅ No regressions detected
- ✅ Performance impact < 1%

**Estimated Effort**: 2-4 hours

---

### 3.3 Success Criteria for Identity Layer Completion

**Status**: 🟡 PENDING APPROVAL  
**Scope**: Comprehensive validation

The Identity Layer is **complete** when ALL of the following are satisfied:

#### Functional Criteria

- [ ] Every new subsystem depends on the Identity Layer
- [ ] No new hardcoded product identifiers are introduced elsewhere
- [ ] Existing functionality behaves identically after adopting the layer
- [ ] Backward compatibility with OpenClaw is maintained
- [ ] Dual resolution works for paths and environment variables
- [ ] Legacy fallback logic is correct

#### Quality Criteria

- [ ] Unit tests cover all public APIs and edge cases (>90% coverage)
- [ ] Integration tests validate backward compatibility
- [ ] Performance tests show < 1% overhead
- [ ] Security review completed
- [ ] Code review completed

#### Documentation Criteria

- [ ] Documentation clearly defines stability guarantees
- [ ] API reference is complete
- [ ] Usage guide is complete
- [ ] Migration guide is complete
- [ ] Examples are provided

#### Validation Criteria

- [ ] A small production subsystem successfully uses the new abstractions without regressions
- [ ] Pilot migration completed successfully
- [ ] No breaking changes detected
- [ ] All stakeholders approve

---

## Part 4: Approval Checklist

### 4.1 API Contracts Review

- [ ] PRODUCT_IDENTITY constant approved
- [ ] LEGACY_IDENTITY constant approved
- [ ] IdentityService interface approved
- [ ] PathResolver interface approved
- [ ] EnvironmentResolver interface approved
- [ ] Configuration schema approved
- [ ] Error model approved
- [ ] Versioning policy approved

### 4.2 Design Rules Review

- [ ] Architectural constraints approved
- [ ] Brand vs Identity separation approved
- [ ] Dependency rules approved
- [ ] Testing requirements approved
- [ ] Documentation requirements approved

### 4.3 Implementation Strategy Review

- [ ] Vertical slices approved
- [ ] Slice order approved
- [ ] Success criteria approved
- [ ] Pilot migration target approved
- [ ] Completion criteria approved

### 4.4 Risk Assessment

- [ ] Technical risks identified
- [ ] Mitigation strategies approved
- [ ] Rollback plan approved
- [ ] Contingency plans approved

### 4.5 Stakeholder Approval

- [ ] Architecture lead approval
- [ ] Engineering lead approval
- [ ] Product lead approval
- [ ] Security review approval
- [ ] Documentation review approval

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Identity Layer** | Operational identity management (paths, env vars, metadata) |
| **Brand Layer** | Visual identity management (logos, colors, marketing copy) |
| **Public API** | Contract guaranteed to remain stable within major version |
| **Breaking Change** | Change that requires users to modify their code |
| **Backward Compatible** | Change that does not require users to modify their code |
| **Fallback** | Alternative resolution when primary resolution fails |
| **Dual Resolution** | Support for both new and legacy names/paths |
| **Deprecation** | Marking something as obsolete with a migration path |

## Appendix B: Related Documents

- `01-ARCHITECTURE-RFC.md` - Overall architecture
- `02-IDENTITY-LAYER-SPEC.md` - Detailed implementation guide
- `03-MIGRATION-SPEC.md` - Migration procedures
- `04-RELEASE-ENGINEERING-SPEC.md` - Release engineering

## Appendix C: Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-21 | Titanium Claws Team | Initial draft |

---

## Next Steps

1. **Review this document** - Read through all sections carefully
2. **Provide feedback** - Suggest changes or clarifications
3. **Approve or reject** - Sign off on the contracts
4. **Proceed to implementation** - Once approved, begin Slice 1

**Contact**: For questions or discussions, reach out to the architecture team.

---

*Document Version: 1.0.0*  
*Last Updated: 2026-07-21*  
*Status: DRAFT - PENDING APPROVAL*
