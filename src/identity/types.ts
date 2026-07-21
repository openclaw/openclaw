/**
 * Titanium Claws Identity Types
 * 
 * Type definitions for the Identity Layer.
 * All types are immutable and define the structure of identity components.
 */

/**
 * Complete product identity definition.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ProductIdentity {
  /** Full product display name */
  readonly displayName: string;
  
  /** Short product name */
  readonly shortName: string;
  
  /** Product tagline */
  readonly tagline: string;
  
  /** Full product description */
  readonly description: string;

  /** CLI executable name (short) */
  readonly executable: string;
  
  /** CLI executable name (full) */
  readonly executableFull: string;
  
  /** NPM package scope */
  readonly packageScope: string;
  
  /** Repository identifier (org/repo) */
  readonly repository: string;

  /** State directory name */
  readonly stateDirectory: string;
  
  /** Configuration file name */
  readonly configFile: string;
  
  /** Database file name */
  readonly databaseFile: string;
  
  /** Log file name */
  readonly logFile: string;
  
  /** Environment variable prefix */
  readonly envPrefix: string;

  /** Product version (semantic versioning) */
  readonly version: string;
  
  /** Compatible OpenClaw version */
  readonly openclawCompatibility: string;
  
  /** Protocol version */
  readonly protocolVersion: string;

  /** Branding configuration */
  readonly branding: BrandingConfig;
  
  /** Documentation URLs */
  readonly urls: URLs;
  
  /** Legal information */
  readonly legal: Legal;
}

/**
 * Legacy identity definition for backward compatibility.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface LegacyIdentity {
  /** Full product display name */
  readonly displayName: string;
  
  /** Short product name */
  readonly shortName: string;
  
  /** Product tagline */
  readonly tagline: string;
  
  /** Full product description */
  readonly description: string;

  /** CLI executable name (short) */
  readonly executable: string;
  
  /** CLI executable name (full) */
  readonly executableFull: string;
  
  /** NPM package scope */
  readonly packageScope: string;
  
  /** Repository identifier (org/repo) */
  readonly repository: string;

  /** State directory name */
  readonly stateDirectory: string;
  
  /** Configuration file name */
  readonly configFile: string;
  
  /** Database file name */
  readonly databaseFile: string;
  
  /** Log file name */
  readonly logFile: string;
  
  /** Environment variable prefix */
  readonly envPrefix: string;

  /** Product version */
  readonly version: string;
  
  /** Compatible OpenClaw version */
  readonly openclawCompatibility: string;
  
  /** Protocol version */
  readonly protocolVersion: string;

  /** Branding configuration */
  readonly branding: BrandingConfig;
  
  /** Documentation URLs */
  readonly urls: URLs;
  
  /** Legal information */
  readonly legal: Legal;
}

/**
 * Branding configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface BrandingConfig {
  /** Logo assets */
  readonly logo: BrandingAssets;
  
  /** Color scheme */
  readonly colors: ColorScheme;
  
  /** Typography configuration */
  readonly typography: Typography;
}

/**
 * Branding assets (logos and icons).
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface BrandingAssets {
  /** Light theme logo */
  readonly light: string;
  
  /** Dark theme logo */
  readonly dark: string;
  
  /** Icon/favicon */
  readonly icon: string;
}

/**
 * Color scheme definition.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ColorScheme {
  /** Primary brand color */
  readonly primary: string;
  
  /** Secondary brand color */
  readonly secondary: string;
  
  /** Accent color */
  readonly accent: string;
  
  /** Success state color */
  readonly success: string;
  
  /** Warning state color */
  readonly warning: string;
  
  /** Error state color */
  readonly error: string;
  
  /** Background color */
  readonly background: string;
  
  /** Text color */
  readonly text: string;
}

/**
 * Typography configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface Typography {
  /** Primary font family */
  readonly fontFamily: string;
  
  /** Monospace font family */
  readonly fontFamilyMono: string;
}

/**
 * Documentation and support URLs.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface URLs {
  /** Main website */
  readonly website: string;
  
  /** Documentation site */
  readonly docs: string;
  
  /** Source code repository */
  readonly repository: string;
  
  /** Issue tracker */
  readonly issues: string;
  
  /** Support email */
  readonly support: string;
}

/**
 * Legal information.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface Legal {
  /** License type */
  readonly license: string;
  
  /** Copyright notice */
  readonly copyright: string;
  
  /** Privacy policy URL */
  readonly privacy: string;
  
  /** Terms of service URL */
  readonly terms: string;
}

/**
 * Configuration file schema for Titanium Claws.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface TitaniumClawsConfig {
  /** Configuration schema version */
  readonly version: string;
  
  /** Migration metadata (optional) */
  readonly _migration?: MigrationMetadata;
  
  /** Product identity override (optional) */
  readonly product?: Partial<ProductIdentity>;
  
  /** Path overrides (optional) */
  readonly paths?: PathOverrides;
  
  /** Environment configuration (optional) */
  readonly environment?: EnvironmentConfig;
  
  /** Branding overrides (optional) */
  readonly branding?: Partial<BrandingConfig>;
  
  /** Compatibility settings (optional) */
  readonly compatibility?: CompatibilityConfig;
  
  /** Gateway configuration (optional) */
  readonly gateway?: GatewayConfig;
  
  /** Agents configuration (optional) */
  readonly agents?: AgentsConfig;
  
  /** Memory configuration (optional) */
  readonly memory?: MemoryConfig;
  
  /** Monitoring configuration (optional) */
  readonly monitoring?: MonitoringConfig;
}

/**
 * Migration metadata for tracking config migrations.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface MigrationMetadata {
  /** Source product name */
  readonly from: 'openclaw';
  
  /** Target product name */
  readonly to: 'titanium-claws';
  
  /** Migration timestamp (ISO 8601) */
  readonly migratedAt: string;
  
  /** Migration tool version */
  readonly version: string;
}

/**
 * Path overrides configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface PathOverrides {
  /** State directory path */
  readonly stateDirectory?: string;
  
  /** Configuration file path */
  readonly configPath?: string;
  
  /** Database file path */
  readonly databasePath?: string;
  
  /** Log file path */
  readonly logPath?: string;
}

/**
 * Environment variable configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface EnvironmentConfig {
  /** Environment variable prefix */
  readonly prefix?: string;
  
  /** Custom environment variables */
  readonly variables?: Record<string, string>;
}

/**
 * Compatibility settings.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface CompatibilityConfig {
  /** Compatible OpenClaw version */
  readonly openclawVersion?: string;
  
  /** Allow legacy environment variables */
  readonly allowLegacyEnvVars?: boolean;
  
  /** Enable automatic migration */
  readonly autoMigrate?: boolean;
}

/**
 * Gateway configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface GatewayConfig {
  /** Gateway port */
  readonly port?: number;
  
  /** Gateway host */
  readonly host?: string;
  
  /** Authentication configuration */
  readonly auth?: GatewayAuthConfig;
  
  /** TLS configuration */
  readonly tls?: TLSConfig;
}

/**
 * Gateway authentication configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface GatewayAuthConfig {
  /** Authentication mode */
  readonly mode?: 'token' | 'password' | 'none';
  
  /** Authentication token */
  readonly token?: string;
  
  /** Authentication password */
  readonly password?: string;
}

/**
 * TLS configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface TLSConfig {
  /** Enable TLS */
  readonly enabled?: boolean;
  
  /** TLS certificate path */
  readonly cert?: string;
  
  /** TLS private key path */
  readonly key?: string;
}

/**
 * Agents configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface AgentsConfig {
  /** Fleet configuration */
  readonly fleet?: FleetConfig;
  
  /** Coordination configuration */
  readonly coordination?: CoordinationConfig;
}

/**
 * Fleet configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface FleetConfig {
  /** Enable multi-agent fleet */
  readonly enabled?: boolean;
  
  /** List of agent types */
  readonly agents?: string[];
}

/**
 * Coordination configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface CoordinationConfig {
  /** Coordination protocol */
  readonly protocol?: 'a2a' | 'grpc' | 'custom';
}

/**
 * Memory configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface MemoryConfig {
  /** Memory backend */
  readonly backend?: 'builtin' | 'qmd';
  
  /** Vector search configuration */
  readonly vector?: VectorConfig;
  
  /** Text search configuration */
  readonly text?: TextSearchConfig;
}

/**
 * Vector search configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface VectorConfig {
  /** Vector search engine */
  readonly engine?: 'hnsw' | 'flat';
  
  /** Vector dimensions */
  readonly dimensions?: number;
}

/**
 * Text search configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface TextSearchConfig {
  /** Text search engine */
  readonly engine?: 'tantivy' | 'fts5';
  
  /** Tokenizer type */
  readonly tokenizer?: string;
}

/**
 * Monitoring configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface MonitoringConfig {
  /** Enable monitoring */
  readonly enabled?: boolean;
  
  /** Metrics configuration */
  readonly metrics?: MetricsConfig;
  
  /** Logging configuration */
  readonly logging?: LoggingConfig;
}

/**
 * Metrics configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface MetricsConfig {
  /** Enable Prometheus metrics */
  readonly prometheus?: PrometheusConfig;
}

/**
 * Prometheus metrics configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface PrometheusConfig {
  /** Enable Prometheus export */
  readonly enabled?: boolean;
  
  /** Prometheus port */
  readonly port?: number;
}

/**
 * Logging configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface LoggingConfig {
  /** Log level */
  readonly level?: string;
  
  /** Log format */
  readonly format?: 'json' | 'text';
}

/**
 * Resolved filesystem paths.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ResolvedPaths {
  /** State directory path */
  readonly stateDirectory: string;
  
  /** Configuration file path */
  readonly configPath: string;
  
  /** Database file path */
  readonly databasePath: string;
  
  /** Log file path */
  readonly logPath: string;
  
  /** Cache directory path */
  readonly cachePath: string;
  
  /** Temporary directory path */
  readonly tempPath: string;
  
  /** Plugins directory path */
  readonly pluginsPath: string;
  
  /** Workspace directory path */
  readonly workspacePath: string;
}

/**
 * Legacy paths for fallback.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface LegacyPaths {
  /** Legacy state directory path */
  readonly stateDirectory: string;
  
  /** Legacy configuration file path */
  readonly configPath: string;
  
  /** Legacy database file path */
  readonly databasePath: string;
  
  /** Legacy log file path */
  readonly logPath: string;
}

/**
 * Resolved environment variables.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ResolvedEnvironment {
  /** State directory from environment */
  readonly stateDir?: string;
  
  /** Configuration path from environment */
  readonly configPath?: string;
  
  /** Gateway token from environment */
  readonly gatewayToken?: string;
  
  /** Gateway password from environment */
  readonly gatewayPassword?: string;
  
  /** Log level from environment */
  readonly logLevel?: string;
  
  /** Database URL from environment */
  readonly databaseUrl?: string;
  
  /** Redis URL from environment */
  readonly redisUrl?: string;
}

/**
 * Environment validation result.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface EnvironmentValidationResult {
  /** Validation status */
  readonly valid: boolean;
  
  /** Validation errors */
  readonly errors: string[];
  
  /** Validation warnings */
  readonly warnings: string[];
}

/**
 * Validation result for identity configuration.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ValidationResult {
  /** Validation status */
  readonly valid: boolean;
  
  /** Validation errors */
  readonly errors: ValidationError[];
}

/**
 * Validation error details.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export interface ValidationError {
  /** Path to the invalid field */
  readonly path: ReadonlyArray<string | number>;
  
  /** Error message */
  readonly message: string;
  
  /** Error code (optional) */
  readonly code?: string;
}

/**
 * Platform type.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type Platform =
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64';

/**
 * Authentication mode.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type AuthMode = 'token' | 'password' | 'none';

/**
 * Log format.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type LogFormat = 'json' | 'text';

/**
 * Memory backend.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type MemoryBackend = 'builtin' | 'qmd';

/**
 * Vector search engine.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type VectorEngine = 'hnsw' | 'flat';

/**
 * Text search engine.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type TextSearchEngine = 'tantivy' | 'fts5';

/**
 * Coordination protocol.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export type CoordinationProtocol = 'a2a' | 'grpc' | 'custom';
