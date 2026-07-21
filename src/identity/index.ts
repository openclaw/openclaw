/**
 * Titanium Claws Identity Layer
 * 
 * Centralized product identity management for Titanium Claws.
 * This module provides a single source of truth for all identity information.
 * 
 * @packageDocumentation
 * @module @titanium-claws/identity
 */

// Export constants
export {
  PRODUCT_IDENTITY,
  LEGACY_IDENTITY,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_TYPOGRAPHY,
  ENVIRONMENT_VARIABLES,
  LEGACY_ENVIRONMENT_VARIABLES,
  SUPPORTED_PLATFORMS,
  SUPPORTED_NODE_VERSIONS,
  FEATURE_FLAGS,
} from './constants.js';

// Export types
export type {
  ProductIdentity,
  LegacyIdentity,
  BrandingConfig,
  BrandingAssets,
  ColorScheme,
  Typography,
  URLs,
  Legal,
  TitaniumClawsConfig,
  MigrationMetadata,
  PathOverrides,
  EnvironmentConfig,
  CompatibilityConfig,
  GatewayConfig,
  GatewayAuthConfig,
  TLSConfig,
  AgentsConfig,
  FleetConfig,
  CoordinationConfig,
  MemoryConfig,
  VectorConfig,
  TextSearchConfig,
  MonitoringConfig,
  MetricsConfig,
  PrometheusConfig,
  LoggingConfig,
  ResolvedPaths,
  LegacyPaths,
  ResolvedEnvironment,
  EnvironmentValidationResult,
  ValidationResult,
  ValidationError as ValidationErrorType,
  Platform,
  AuthMode,
  LogFormat,
  MemoryBackend,
  VectorEngine,
  TextSearchEngine,
  CoordinationProtocol,
} from './types.js';

// Export errors
export {
  IdentityError,
  ConfigError,
  PathError,
  EnvironmentError,
  ValidationError,
  MigrationError,
  CompatibilityError,
  RuntimeError,
  IdentityErrorCode,
  ERROR_MESSAGES,
  createIdentityError,
  isIdentityError,
  hasErrorCode,
  createError,
  createConfigError,
  createPathError,
  createEnvironmentError,
  createValidationError,
  createMigrationError,
  createCompatibilityError,
  createRuntimeError,
} from './errors.js';

// Export IdentityService
export {
  IdentityService,
  getIdentityService,
  resetIdentityService,
} from './identity-service.js';

// Export IdentityService types
export type {
  IdentityServiceOptions,
  ProductInfo,
} from './identity-service.js';

// Export PathResolver
export {
  PathResolver,
  getPathResolver,
  resetPathResolver,
} from './path-resolver.js';

// Export PathResolver types
export type {
  PathResolverOptions,
  PathResolutionResult,
} from './path-resolver.js';
