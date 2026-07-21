/**
 * Titanium Claws Identity Layer Errors
 * 
 * Error classes and error codes for the Identity Layer.
 * All errors extend the base IdentityError class.
 */

/**
 * Error codes for Identity Layer errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export enum IdentityErrorCode {
  // Configuration errors
  INVALID_CONFIG = 'INVALID_CONFIG',
  MISSING_VERSION = 'MISSING_VERSION',
  INVALID_VERSION = 'INVALID_VERSION',
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  CONFIG_PARSE_ERROR = 'CONFIG_PARSE_ERROR',

  // Path resolution errors
  PATH_NOT_FOUND = 'PATH_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  PATH_RESOLUTION_FAILED = 'PATH_RESOLUTION_FAILED',
  DIRECTORY_CREATION_FAILED = 'DIRECTORY_CREATION_FAILED',

  // Environment errors
  INVALID_ENV_VAR = 'INVALID_ENV_VAR',
  CONFLICTING_ENV_VARS = 'CONFLICTING_ENV_VARS',
  MISSING_REQUIRED_ENV_VAR = 'MISSING_REQUIRED_ENV_VAR',

  // Validation errors
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_FIELD = 'INVALID_FIELD',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',

  // Migration errors
  MIGRATION_FAILED = 'MIGRATION_FAILED',
  ROLLBACK_FAILED = 'ROLLBACK_FAILED',
  MIGRATION_NOT_SUPPORTED = 'MIGRATION_NOT_SUPPORTED',

  // Compatibility errors
  INCOMPATIBLE_VERSION = 'INCOMPATIBLE_VERSION',
  LEGACY_PATH_NOT_FOUND = 'LEGACY_PATH_NOT_FOUND',
  LEGACY_ENV_VAR_DEPRECATED = 'LEGACY_ENV_VAR_DEPRECATED',

  // Runtime errors
  IDENTITY_NOT_INITIALIZED = 'IDENTITY_NOT_INITIALIZED',
  IDENTITY_SERVICE_ERROR = 'IDENTITY_SERVICE_ERROR',
  PATH_RESOLVER_ERROR = 'PATH_RESOLVER_ERROR',
  ENVIRONMENT_RESOLVER_ERROR = 'ENVIRONMENT_RESOLVER_ERROR',
}

/**
 * Base error class for Identity Layer errors.
 * 
 * All Identity Layer errors extend this class to provide consistent
 * error handling and error code support.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class IdentityError extends Error {
  /**
   * Error code for programmatic error handling.
   */
  public readonly code: IdentityErrorCode;

  /**
   * Original error that caused this error (if any).
   */
  public readonly cause?: Error;

  /**
   * Additional error context.
   */
  public readonly context?: Record<string, unknown>;

  /**
   * Create a new IdentityError.
   * 
   * @param message - Human-readable error message
   * @param code - Error code for programmatic handling
   * @param cause - Original error that caused this error
   * @param context - Additional error context
   */
  constructor(
    message: string,
    code: IdentityErrorCode,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.cause = cause;
    this.context = context;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IdentityError);
    }
  }

  /**
   * Convert error to JSON representation.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
          }
        : undefined,
    };
  }

  /**
   * Check if error is a specific type.
   */
  is(code: IdentityErrorCode): boolean {
    return this.code === code;
  }
}

/**
 * Configuration-related errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class ConfigError extends IdentityError {
  constructor(
    message: string,
    code:
      | IdentityErrorCode.INVALID_CONFIG
      | IdentityErrorCode.MISSING_VERSION
      | IdentityErrorCode.INVALID_VERSION
      | IdentityErrorCode.CONFIG_NOT_FOUND
      | IdentityErrorCode.CONFIG_PARSE_ERROR,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, code, cause, context);
    this.name = 'ConfigError';
  }
}

/**
 * Path resolution errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class PathError extends IdentityError {
  constructor(
    message: string,
    code:
      | IdentityErrorCode.PATH_NOT_FOUND
      | IdentityErrorCode.PERMISSION_DENIED
      | IdentityErrorCode.PATH_RESOLUTION_FAILED
      | IdentityErrorCode.DIRECTORY_CREATION_FAILED,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, code, cause, context);
    this.name = 'PathError';
  }
}

/**
 * Environment variable errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class EnvironmentError extends IdentityError {
  constructor(
    message: string,
    code:
      | IdentityErrorCode.INVALID_ENV_VAR
      | IdentityErrorCode.CONFLICTING_ENV_VARS
      | IdentityErrorCode.MISSING_REQUIRED_ENV_VAR,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, code, cause, context);
    this.name = 'EnvironmentError';
  }
}

/**
 * Validation errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class ValidationError extends IdentityError {
  /**
   * Validation errors with detailed field information.
   */
  public readonly validationErrors: ReadonlyArray<{
    path: ReadonlyArray<string | number>;
    message: string;
    code?: string;
  }>;

  constructor(
    message: string,
    validationErrors: ReadonlyArray<{
      path: ReadonlyArray<string | number>;
      message: string;
      code?: string;
    }>,
    context?: Record<string, unknown>,
  ) {
    super(message, IdentityErrorCode.VALIDATION_FAILED, undefined, context);
    this.name = 'ValidationError';
    this.validationErrors = validationErrors;
  }
}

/**
 * Migration errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class MigrationError extends IdentityError {
  constructor(
    message: string,
    code:
      | IdentityErrorCode.MIGRATION_FAILED
      | IdentityErrorCode.ROLLBACK_FAILED
      | IdentityErrorCode.MIGRATION_NOT_SUPPORTED,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, code, cause, context);
    this.name = 'MigrationError';
  }
}

/**
 * Compatibility errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class CompatibilityError extends IdentityError {
  constructor(
    message: string,
    code:
      | IdentityErrorCode.INCOMPATIBLE_VERSION
      | IdentityErrorCode.LEGACY_PATH_NOT_FOUND
      | IdentityErrorCode.LEGACY_ENV_VAR_DEPRECATED,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, code, cause, context);
    this.name = 'CompatibilityError';
  }
}

/**
 * Runtime errors.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export class RuntimeError extends IdentityError {
  constructor(
    message: string,
    code:
      | IdentityErrorCode.IDENTITY_NOT_INITIALIZED
      | IdentityErrorCode.IDENTITY_SERVICE_ERROR
      | IdentityErrorCode.PATH_RESOLVER_ERROR
      | IdentityErrorCode.ENVIRONMENT_RESOLVER_ERROR,
    cause?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, code, cause, context);
    this.name = 'RuntimeError';
  }
}

/**
 * Helper function to create an IdentityError from an unknown error.
 * 
 * @param error - Unknown error to wrap
 * @param code - Error code to assign
 * @param context - Additional context
 * @returns IdentityError instance
 */
export function createIdentityError(
  error: unknown,
  code: IdentityErrorCode,
  context?: Record<string, unknown>,
): IdentityError {
  if (error instanceof IdentityError) {
    return error;
  }

  if (error instanceof Error) {
    return new IdentityError(error.message, code, error, context);
  }

  return new IdentityError(
    String(error),
    code,
    undefined,
    context,
  );
}

/**
 * Helper function to check if an error is an IdentityError.
 * 
 * @param error - Error to check
 * @returns True if error is an IdentityError
 */
export function isIdentityError(error: unknown): error is IdentityError {
  return error instanceof IdentityError;
}

/**
 * Helper function to check if an error has a specific code.
 * 
 * @param error - Error to check
 * @param code - Error code to check for
 * @returns True if error has the specified code
 */
export function hasErrorCode(
  error: unknown,
  code: IdentityErrorCode,
): boolean {
  return isIdentityError(error) && error.code === code;
}

/**
 * Error messages for common error scenarios.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const ERROR_MESSAGES = {
  [IdentityErrorCode.INVALID_CONFIG]: 'Invalid configuration',
  [IdentityErrorCode.MISSING_VERSION]: 'Missing required "version" field in configuration',
  [IdentityErrorCode.INVALID_VERSION]: 'Invalid version format. Expected semantic versioning (e.g., "1.0.0")',
  [IdentityErrorCode.CONFIG_NOT_FOUND]: 'Configuration file not found',
  [IdentityErrorCode.CONFIG_PARSE_ERROR]: 'Failed to parse configuration file',
  [IdentityErrorCode.PATH_NOT_FOUND]: 'Path does not exist',
  [IdentityErrorCode.PERMISSION_DENIED]: 'Permission denied',
  [IdentityErrorCode.PATH_RESOLUTION_FAILED]: 'Failed to resolve path',
  [IdentityErrorCode.DIRECTORY_CREATION_FAILED]: 'Failed to create directory',
  [IdentityErrorCode.INVALID_ENV_VAR]: 'Invalid environment variable',
  [IdentityErrorCode.CONFLICTING_ENV_VARS]: 'Conflicting environment variables detected',
  [IdentityErrorCode.MISSING_REQUIRED_ENV_VAR]: 'Missing required environment variable',
  [IdentityErrorCode.VALIDATION_FAILED]: 'Validation failed',
  [IdentityErrorCode.INVALID_FIELD]: 'Invalid field value',
  [IdentityErrorCode.MISSING_REQUIRED_FIELD]: 'Missing required field',
  [IdentityErrorCode.MIGRATION_FAILED]: 'Migration failed',
  [IdentityErrorCode.ROLLBACK_FAILED]: 'Rollback failed',
  [IdentityErrorCode.MIGRATION_NOT_SUPPORTED]: 'Migration not supported for this version',
  [IdentityErrorCode.INCOMPATIBLE_VERSION]: 'Incompatible version',
  [IdentityErrorCode.LEGACY_PATH_NOT_FOUND]: 'Legacy path not found',
  [IdentityErrorCode.LEGACY_ENV_VAR_DEPRECATED]: 'Legacy environment variable deprecated',
  [IdentityErrorCode.IDENTITY_NOT_INITIALIZED]: 'Identity service not initialized',
  [IdentityErrorCode.IDENTITY_SERVICE_ERROR]: 'Identity service error',
  [IdentityErrorCode.PATH_RESOLVER_ERROR]: 'Path resolver error',
  [IdentityErrorCode.ENVIRONMENT_RESOLVER_ERROR]: 'Environment resolver error',
} as const;

/**
 * Create an error with a default message for a specific error code.
 * 
 * @param code - Error code
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns IdentityError instance
 */
export function createError(
  code: IdentityErrorCode,
  cause?: Error,
  context?: Record<string, unknown>,
): IdentityError {
  const message = ERROR_MESSAGES[code];
  return new IdentityError(message, code, cause, context);
}

/**
 * Create a configuration error with a specific message.
 * 
 * @param message - Error message
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns ConfigError instance
 */
export function createConfigError(
  message: string,
  cause?: Error,
  context?: Record<string, unknown>,
): ConfigError {
  return new ConfigError(message, IdentityErrorCode.INVALID_CONFIG, cause, context);
}

/**
 * Create a path error with a specific message.
 * 
 * @param message - Error message
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns PathError instance
 */
export function createPathError(
  message: string,
  cause?: Error,
  context?: Record<string, unknown>,
): PathError {
  return new PathError(message, IdentityErrorCode.PATH_RESOLUTION_FAILED, cause, context);
}

/**
 * Create an environment error with a specific message.
 * 
 * @param message - Error message
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns EnvironmentError instance
 */
export function createEnvironmentError(
  message: string,
  cause?: Error,
  context?: Record<string, unknown>,
): EnvironmentError {
  return new EnvironmentError(message, IdentityErrorCode.INVALID_ENV_VAR, cause, context);
}

/**
 * Create a validation error with detailed field information.
 * 
 * @param validationErrors - Array of validation errors
 * @param context - Additional context (optional)
 * @returns ValidationError instance
 */
export function createValidationError(
  validationErrors: ReadonlyArray<{
    path: ReadonlyArray<string | number>;
    message: string;
    code?: string;
  }>,
  context?: Record<string, unknown>,
): ValidationError {
  const message = `Validation failed with ${validationErrors.length} error(s)`;
  return new ValidationError(message, validationErrors, context);
}

/**
 * Create a migration error with a specific message.
 * 
 * @param message - Error message
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns MigrationError instance
 */
export function createMigrationError(
  message: string,
  cause?: Error,
  context?: Record<string, unknown>,
): MigrationError {
  return new MigrationError(message, IdentityErrorCode.MIGRATION_FAILED, cause, context);
}

/**
 * Create a compatibility error with a specific message.
 * 
 * @param message - Error message
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns CompatibilityError instance
 */
export function createCompatibilityError(
  message: string,
  cause?: Error,
  context?: Record<string, unknown>,
): CompatibilityError {
  return new CompatibilityError(message, IdentityErrorCode.INCOMPATIBLE_VERSION, cause, context);
}

/**
 * Create a runtime error with a specific message.
 * 
 * @param message - Error message
 * @param cause - Original error (optional)
 * @param context - Additional context (optional)
 * @returns RuntimeError instance
 */
export function createRuntimeError(
  message: string,
  cause?: Error,
  context?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(message, IdentityErrorCode.IDENTITY_SERVICE_ERROR, cause, context);
}
