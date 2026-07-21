/**
 * Tests for Identity Layer errors
 */

import { describe, it, expect } from 'vitest';
import {
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
} from '../errors.js';

describe('Identity Errors', () => {
  describe('IdentityError', () => {
    it('should create error with message and code', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(IdentityErrorCode.INVALID_CONFIG);
      expect(error.name).toBe('IdentityError');
    });

    it('should accept optional cause', () => {
      const cause = new Error('Original error');
      const error = new IdentityError(
        'Wrapped error',
        IdentityErrorCode.INVALID_CONFIG,
        cause,
      );

      expect(error.cause).toBe(cause);
      expect(error.message).toBe('Original error');
    });

    it('should accept optional context', () => {
      const context = { field: 'version', value: 'invalid' };
      const error = new IdentityError(
        'Validation failed',
        IdentityErrorCode.INVALID_CONFIG,
        undefined,
        context,
      );

      expect(error.context).toEqual(context);
    });

    it('should convert to JSON', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
        undefined,
        { field: 'version' },
      );

      const json = error.toJSON();
      expect(json.name).toBe('IdentityError');
      expect(json.message).toBe('Test error');
      expect(json.code).toBe(IdentityErrorCode.INVALID_CONFIG);
      expect(json.context).toEqual({ field: 'version' });
    });

    it('should check error code', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error.is(IdentityErrorCode.INVALID_CONFIG)).toBe(true);
      expect(error.is(IdentityErrorCode.MISSING_VERSION)).toBe(false);
    });

    it('should be instance of Error', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error instanceof Error).toBe(true);
      expect(error instanceof IdentityError).toBe(true);
    });
  });

  describe('ConfigError', () => {
    it('should create config error', () => {
      const error = new ConfigError(
        'Invalid config',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error.message).toBe('Invalid config');
      expect(error.code).toBe(IdentityErrorCode.INVALID_CONFIG);
      expect(error.name).toBe('ConfigError');
    });

    it('should accept specific error codes', () => {
      const codes = [
        IdentityErrorCode.INVALID_CONFIG,
        IdentityErrorCode.MISSING_VERSION,
        IdentityErrorCode.INVALID_VERSION,
        IdentityErrorCode.CONFIG_NOT_FOUND,
        IdentityErrorCode.CONFIG_PARSE_ERROR,
      ];

      codes.forEach(code => {
        const error = new ConfigError('Config error', code);
        expect(error.code).toBe(code);
      });
    });

    it('should be instance of IdentityError', () => {
      const error = new ConfigError(
        'Config error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error instanceof IdentityError).toBe(true);
      expect(error instanceof ConfigError).toBe(true);
    });
  });

  describe('PathError', () => {
    it('should create path error', () => {
      const error = new PathError(
        'Path not found',
        IdentityErrorCode.PATH_NOT_FOUND,
      );

      expect(error.message).toBe('Path not found');
      expect(error.code).toBe(IdentityErrorCode.PATH_NOT_FOUND);
      expect(error.name).toBe('PathError');
    });

    it('should accept specific error codes', () => {
      const codes = [
        IdentityErrorCode.PATH_NOT_FOUND,
        IdentityErrorCode.PERMISSION_DENIED,
        IdentityErrorCode.PATH_RESOLUTION_FAILED,
        IdentityErrorCode.DIRECTORY_CREATION_FAILED,
      ];

      codes.forEach(code => {
        const error = new PathError('Path error', code);
        expect(error.code).toBe(code);
      });
    });
  });

  describe('EnvironmentError', () => {
    it('should create environment error', () => {
      const error = new EnvironmentError(
        'Invalid env var',
        IdentityErrorCode.INVALID_ENV_VAR,
      );

      expect(error.message).toBe('Invalid env var');
      expect(error.code).toBe(IdentityErrorCode.INVALID_ENV_VAR);
      expect(error.name).toBe('EnvironmentError');
    });

    it('should accept specific error codes', () => {
      const codes = [
        IdentityErrorCode.INVALID_ENV_VAR,
        IdentityErrorCode.CONFLICTING_ENV_VARS,
        IdentityErrorCode.MISSING_REQUIRED_ENV_VAR,
      ];

      codes.forEach(code => {
        const error = new EnvironmentError('Env error', code);
        expect(error.code).toBe(code);
      });
    });
  });

  describe('ValidationError', () => {
    it('should create validation error with errors array', () => {
      const validationErrors = [
        { path: ['version'], message: 'Missing required field' },
        { path: ['gateway', 'port'], message: 'Invalid port number' },
      ];

      const error = new ValidationError('Validation failed', validationErrors);

      expect(error.message).toBe('Validation failed');
      expect(error.code).toBe(IdentityErrorCode.VALIDATION_FAILED);
      expect(error.name).toBe('ValidationError');
      expect(error.validationErrors).toHaveLength(2);
    });

    it('should include detailed error information', () => {
      const validationErrors = [
        {
          path: ['version'],
          message: 'Missing required field',
          code: 'MISSING_REQUIRED_FIELD',
        },
      ];

      const error = new ValidationError('Validation failed', validationErrors);

      expect(error.validationErrors[0].path).toEqual(['version']);
      expect(error.validationErrors[0].message).toBe('Missing required field');
      expect(error.validationErrors[0].code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('should be instance of IdentityError', () => {
      const error = new ValidationError('Validation failed', []);

      expect(error instanceof IdentityError).toBe(true);
      expect(error instanceof ValidationError).toBe(true);
    });
  });

  describe('MigrationError', () => {
    it('should create migration error', () => {
      const error = new MigrationError(
        'Migration failed',
        IdentityErrorCode.MIGRATION_FAILED,
      );

      expect(error.message).toBe('Migration failed');
      expect(error.code).toBe(IdentityErrorCode.MIGRATION_FAILED);
      expect(error.name).toBe('MigrationError');
    });

    it('should accept specific error codes', () => {
      const codes = [
        IdentityErrorCode.MIGRATION_FAILED,
        IdentityErrorCode.ROLLBACK_FAILED,
        IdentityErrorCode.MIGRATION_NOT_SUPPORTED,
      ];

      codes.forEach(code => {
        const error = new MigrationError('Migration error', code);
        expect(error.code).toBe(code);
      });
    });
  });

  describe('CompatibilityError', () => {
    it('should create compatibility error', () => {
      const error = new CompatibilityError(
        'Incompatible version',
        IdentityErrorCode.INCOMPATIBLE_VERSION,
      );

      expect(error.message).toBe('Incompatible version');
      expect(error.code).toBe(IdentityErrorCode.INCOMPATIBLE_VERSION);
      expect(error.name).toBe('CompatibilityError');
    });

    it('should accept specific error codes', () => {
      const codes = [
        IdentityErrorCode.INCOMPATIBLE_VERSION,
        IdentityErrorCode.LEGACY_PATH_NOT_FOUND,
        IdentityErrorCode.LEGACY_ENV_VAR_DEPRECATED,
      ];

      codes.forEach(code => {
        const error = new CompatibilityError('Compat error', code);
        expect(error.code).toBe(code);
      });
    });
  });

  describe('RuntimeError', () => {
    it('should create runtime error', () => {
      const error = new RuntimeError(
        'Identity not initialized',
        IdentityErrorCode.IDENTITY_NOT_INITIALIZED,
      );

      expect(error.message).toBe('Identity not initialized');
      expect(error.code).toBe(IdentityErrorCode.IDENTITY_NOT_INITIALIZED);
      expect(error.name).toBe('RuntimeError');
    });

    it('should accept specific error codes', () => {
      const codes = [
        IdentityErrorCode.IDENTITY_NOT_INITIALIZED,
        IdentityErrorCode.IDENTITY_SERVICE_ERROR,
        IdentityErrorCode.PATH_RESOLVER_ERROR,
        IdentityErrorCode.ENVIRONMENT_RESOLVER_ERROR,
      ];

      codes.forEach(code => {
        const error = new RuntimeError('Runtime error', code);
        expect(error.code).toBe(code);
      });
    });
  });

  describe('IdentityErrorCode', () => {
    it('should have all configuration error codes', () => {
      expect(IdentityErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
      expect(IdentityErrorCode.MISSING_VERSION).toBe('MISSING_VERSION');
      expect(IdentityErrorCode.INVALID_VERSION).toBe('INVALID_VERSION');
      expect(IdentityErrorCode.CONFIG_NOT_FOUND).toBe('CONFIG_NOT_FOUND');
      expect(IdentityErrorCode.CONFIG_PARSE_ERROR).toBe('CONFIG_PARSE_ERROR');
    });

    it('should have all path error codes', () => {
      expect(IdentityErrorCode.PATH_NOT_FOUND).toBe('PATH_NOT_FOUND');
      expect(IdentityErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
      expect(IdentityErrorCode.PATH_RESOLUTION_FAILED).toBe('PATH_RESOLUTION_FAILED');
      expect(IdentityErrorCode.DIRECTORY_CREATION_FAILED).toBe('DIRECTORY_CREATION_FAILED');
    });

    it('should have all environment error codes', () => {
      expect(IdentityErrorCode.INVALID_ENV_VAR).toBe('INVALID_ENV_VAR');
      expect(IdentityErrorCode.CONFLICTING_ENV_VARS).toBe('CONFLICTING_ENV_VARS');
      expect(IdentityErrorCode.MISSING_REQUIRED_ENV_VAR).toBe('MISSING_REQUIRED_ENV_VAR');
    });

    it('should have all validation error codes', () => {
      expect(IdentityErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
      expect(IdentityErrorCode.INVALID_FIELD).toBe('INVALID_FIELD');
      expect(IdentityErrorCode.MISSING_REQUIRED_FIELD).toBe('MISSING_REQUIRED_FIELD');
    });

    it('should have all migration error codes', () => {
      expect(IdentityErrorCode.MIGRATION_FAILED).toBe('MIGRATION_FAILED');
      expect(IdentityErrorCode.ROLLBACK_FAILED).toBe('ROLLBACK_FAILED');
      expect(IdentityErrorCode.MIGRATION_NOT_SUPPORTED).toBe('MIGRATION_NOT_SUPPORTED');
    });

    it('should have all compatibility error codes', () => {
      expect(IdentityErrorCode.INCOMPATIBLE_VERSION).toBe('INCOMPATIBLE_VERSION');
      expect(IdentityErrorCode.LEGACY_PATH_NOT_FOUND).toBe('LEGACY_PATH_NOT_FOUND');
      expect(IdentityErrorCode.LEGACY_ENV_VAR_DEPRECATED).toBe('LEGACY_ENV_VAR_DEPRECATED');
    });

    it('should have all runtime error codes', () => {
      expect(IdentityErrorCode.IDENTITY_NOT_INITIALIZED).toBe('IDENTITY_NOT_INITIALIZED');
      expect(IdentityErrorCode.IDENTITY_SERVICE_ERROR).toBe('IDENTITY_SERVICE_ERROR');
      expect(IdentityErrorCode.PATH_RESOLVER_ERROR).toBe('PATH_RESOLVER_ERROR');
      expect(IdentityErrorCode.ENVIRONMENT_RESOLVER_ERROR).toBe('ENVIRONMENT_RESOLVER_ERROR');
    });
  });

  describe('ERROR_MESSAGES', () => {
    it('should have message for each error code', () => {
      Object.values(IdentityErrorCode).forEach(code => {
        expect(ERROR_MESSAGES[code]).toBeDefined();
        expect(typeof ERROR_MESSAGES[code]).toBe('string');
        expect(ERROR_MESSAGES[code].length).toBeGreaterThan(0);
      });
    });

    it('should have descriptive messages', () => {
      expect(ERROR_MESSAGES[IdentityErrorCode.INVALID_CONFIG]).toContain('configuration');
      expect(ERROR_MESSAGES[IdentityErrorCode.MISSING_VERSION]).toContain('version');
      expect(ERROR_MESSAGES[IdentityErrorCode.PATH_NOT_FOUND]).toContain('Path');
      expect(ERROR_MESSAGES[IdentityErrorCode.INVALID_ENV_VAR]).toContain('environment');
    });
  });

  describe('createIdentityError', () => {
    it('should create IdentityError from unknown error', () => {
      const unknownError = new Error('Unknown error');
      const error = createIdentityError(
        unknownError,
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error instanceof IdentityError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.INVALID_CONFIG);
    });

    it('should return IdentityError as-is', () => {
      const originalError = new IdentityError(
        'Original error',
        IdentityErrorCode.INVALID_CONFIG,
      );
      const error = createIdentityError(
        originalError,
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error).toBe(originalError);
    });

    it('should convert string to IdentityError', () => {
      const error = createIdentityError(
        'String error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(error instanceof IdentityError).toBe(true);
      expect(error.message).toBe('String error');
    });

    it('should accept context', () => {
      const context = { field: 'version' };
      const error = createIdentityError(
        new Error('Test'),
        IdentityErrorCode.INVALID_CONFIG,
        context,
      );

      expect(error.context).toEqual(context);
    });
  });

  describe('isIdentityError', () => {
    it('should return true for IdentityError', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(isIdentityError(error)).toBe(true);
    });

    it('should return true for IdentityError subclasses', () => {
      const error = new ConfigError(
        'Config error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(isIdentityError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Regular error');

      expect(isIdentityError(error)).toBe(false);
    });

    it('should return false for non-Error objects', () => {
      expect(isIdentityError('string')).toBe(false);
      expect(isIdentityError(123)).toBe(false);
      expect(isIdentityError(null)).toBe(false);
      expect(isIdentityError(undefined)).toBe(false);
    });
  });

  describe('hasErrorCode', () => {
    it('should return true for matching error code', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(hasErrorCode(error, IdentityErrorCode.INVALID_CONFIG)).toBe(true);
    });

    it('should return false for non-matching error code', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(hasErrorCode(error, IdentityErrorCode.MISSING_VERSION)).toBe(false);
    });

    it('should return false for non-IdentityError', () => {
      const error = new Error('Regular error');

      expect(hasErrorCode(error, IdentityErrorCode.INVALID_CONFIG)).toBe(false);
    });
  });

  describe('createError', () => {
    it('should create error with default message', () => {
      const error = createError(IdentityErrorCode.INVALID_CONFIG);

      expect(error instanceof IdentityError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.INVALID_CONFIG);
      expect(error.message).toBe(ERROR_MESSAGES[IdentityErrorCode.INVALID_CONFIG]);
    });

    it('should accept cause', () => {
      const cause = new Error('Original error');
      const error = createError(IdentityErrorCode.INVALID_CONFIG, cause);

      expect(error.cause).toBe(cause);
    });

    it('should accept context', () => {
      const context = { field: 'version' };
      const error = createError(
        IdentityErrorCode.INVALID_CONFIG,
        undefined,
        context,
      );

      expect(error.context).toEqual(context);
    });
  });

  describe('Helper functions', () => {
    it('should create config error', () => {
      const error = createConfigError('Invalid config');

      expect(error instanceof ConfigError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.INVALID_CONFIG);
    });

    it('should create path error', () => {
      const error = createPathError('Path not found');

      expect(error instanceof PathError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.PATH_RESOLUTION_FAILED);
    });

    it('should create environment error', () => {
      const error = createEnvironmentError('Invalid env var');

      expect(error instanceof EnvironmentError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.INVALID_ENV_VAR);
    });

    it('should create validation error', () => {
      const validationErrors = [
        { path: ['version'], message: 'Missing required field' },
      ];
      const error = createValidationError(validationErrors);

      expect(error instanceof ValidationError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.VALIDATION_FAILED);
      expect(error.validationErrors).toHaveLength(1);
    });

    it('should create migration error', () => {
      const error = createMigrationError('Migration failed');

      expect(error instanceof MigrationError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.MIGRATION_FAILED);
    });

    it('should create compatibility error', () => {
      const error = createCompatibilityError('Incompatible version');

      expect(error instanceof CompatibilityError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.INCOMPATIBLE_VERSION);
    });

    it('should create runtime error', () => {
      const error = createRuntimeError('Identity not initialized');

      expect(error instanceof RuntimeError).toBe(true);
      expect(error.code).toBe(IdentityErrorCode.IDENTITY_SERVICE_ERROR);
    });
  });

  describe('Error inheritance', () => {
    it('should maintain inheritance chain', () => {
      const configError = new ConfigError(
        'Config error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      expect(configError instanceof ConfigError).toBe(true);
      expect(configError instanceof IdentityError).toBe(true);
      expect(configError instanceof Error).toBe(true);
    });

    it('should preserve error name', () => {
      const errors = [
        new ConfigError('Config error', IdentityErrorCode.INVALID_CONFIG),
        new PathError('Path error', IdentityErrorCode.PATH_NOT_FOUND),
        new EnvironmentError('Env error', IdentityErrorCode.INVALID_ENV_VAR),
        new ValidationError('Validation error', []),
        new MigrationError('Migration error', IdentityErrorCode.MIGRATION_FAILED),
        new CompatibilityError('Compat error', IdentityErrorCode.INCOMPATIBLE_VERSION),
        new RuntimeError('Runtime error', IdentityErrorCode.IDENTITY_SERVICE_ERROR),
      ];

      expect(errors[0].name).toBe('ConfigError');
      expect(errors[1].name).toBe('PathError');
      expect(errors[2].name).toBe('EnvironmentError');
      expect(errors[3].name).toBe('ValidationError');
      expect(errors[4].name).toBe('MigrationError');
      expect(errors[5].name).toBe('CompatibilityError');
      expect(errors[6].name).toBe('RuntimeError');
    });
  });

  describe('Error serialization', () => {
    it('should serialize to JSON correctly', () => {
      const cause = new Error('Original error');
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
        cause,
        { field: 'version', value: 'invalid' },
      );

      const json = error.toJSON();

      expect(json.name).toBe('IdentityError');
      expect(json.message).toBe('Test error');
      expect(json.code).toBe(IdentityErrorCode.INVALID_CONFIG);
      expect(json.context).toEqual({ field: 'version', value: 'invalid' });
      expect(json.cause).toEqual({
        name: 'Error',
        message: 'Original error',
      });
    });

    it('should serialize without cause', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      const json = error.toJSON();

      expect(json.cause).toBeUndefined();
    });

    it('should serialize without context', () => {
      const error = new IdentityError(
        'Test error',
        IdentityErrorCode.INVALID_CONFIG,
      );

      const json = error.toJSON();

      expect(json.context).toBeUndefined();
    });
  });
});
