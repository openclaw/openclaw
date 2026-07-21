/**
 * Tests for Identity Layer types
 */

import { describe, it, expect } from 'vitest';
import { PRODUCT_IDENTITY, LEGACY_IDENTITY } from '../constants.js';
import type {
  ProductIdentity,
  LegacyIdentity,
  BrandingConfig,
  ColorScheme,
  Typography,
  URLs,
  Legal,
  TitaniumClawsConfig,
  ResolvedPaths,
  ResolvedEnvironment,
  ValidationResult,
} from '../types.js';

describe('Identity Types', () => {
  describe('ProductIdentity', () => {
    it('should conform to ProductIdentity interface', () => {
      const identity: ProductIdentity = PRODUCT_IDENTITY;
      
      expect(identity.displayName).toBeTypeOf('string');
      expect(identity.shortName).toBeTypeOf('string');
      expect(identity.tagline).toBeTypeOf('string');
      expect(identity.description).toBeTypeOf('string');
      
      expect(identity.executable).toBeTypeOf('string');
      expect(identity.executableFull).toBeTypeOf('string');
      expect(identity.packageScope).toBeTypeOf('string');
      expect(identity.repository).toBeTypeOf('string');
      
      expect(identity.stateDirectory).toBeTypeOf('string');
      expect(identity.configFile).toBeTypeOf('string');
      expect(identity.databaseFile).toBeTypeOf('string');
      expect(identity.logFile).toBeTypeOf('string');
      expect(identity.envPrefix).toBeTypeOf('string');
      
      expect(identity.version).toBeTypeOf('string');
      expect(identity.openclawCompatibility).toBeTypeOf('string');
      expect(identity.protocolVersion).toBeTypeOf('string');
      
      expect(identity.branding).toBeTypeOf('object');
      expect(identity.urls).toBeTypeOf('object');
      expect(identity.legal).toBeTypeOf('object');
    });

    it('should have all required fields', () => {
      const requiredFields: Array<keyof ProductIdentity> = [
        'displayName',
        'shortName',
        'tagline',
        'description',
        'executable',
        'executableFull',
        'packageScope',
        'repository',
        'stateDirectory',
        'configFile',
        'databaseFile',
        'logFile',
        'envPrefix',
        'version',
        'openclawCompatibility',
        'protocolVersion',
        'branding',
        'urls',
        'legal',
      ];

      requiredFields.forEach(field => {
        expect(PRODUCT_IDENTITY).toHaveProperty(field);
      });
    });
  });

  describe('LegacyIdentity', () => {
    it('should conform to LegacyIdentity interface', () => {
      const identity: LegacyIdentity = LEGACY_IDENTITY;
      
      expect(identity.displayName).toBeTypeOf('string');
      expect(identity.shortName).toBeTypeOf('string');
      expect(identity.tagline).toBeTypeOf('string');
      expect(identity.description).toBeTypeOf('string');
      
      expect(identity.executable).toBeTypeOf('string');
      expect(identity.executableFull).toBeTypeOf('string');
      expect(identity.packageScope).toBeTypeOf('string');
      expect(identity.repository).toBeTypeOf('string');
      
      expect(identity.stateDirectory).toBeTypeOf('string');
      expect(identity.configFile).toBeTypeOf('string');
      expect(identity.databaseFile).toBeTypeOf('string');
      expect(identity.logFile).toBeTypeOf('string');
      expect(identity.envPrefix).toBeTypeOf('string');
      
      expect(identity.version).toBeTypeOf('string');
      expect(identity.openclawCompatibility).toBeTypeOf('string');
      expect(identity.protocolVersion).toBeTypeOf('string');
      
      expect(identity.branding).toBeTypeOf('object');
      expect(identity.urls).toBeTypeOf('object');
      expect(identity.legal).toBeTypeOf('object');
    });

    it('should have all required fields', () => {
      const requiredFields: Array<keyof LegacyIdentity> = [
        'displayName',
        'shortName',
        'tagline',
        'description',
        'executable',
        'executableFull',
        'packageScope',
        'repository',
        'stateDirectory',
        'configFile',
        'databaseFile',
        'logFile',
        'envPrefix',
        'version',
        'openclawCompatibility',
        'protocolVersion',
        'branding',
        'urls',
        'legal',
      ];

      requiredFields.forEach(field => {
        expect(LEGACY_IDENTITY).toHaveProperty(field);
      });
    });
  });

  describe('BrandingConfig', () => {
    it('should have logo assets', () => {
      const branding: BrandingConfig = PRODUCT_IDENTITY.branding;
      
      expect(branding.logo).toBeDefined();
      expect(branding.logo.light).toBeTypeOf('string');
      expect(branding.logo.dark).toBeTypeOf('string');
      expect(branding.logo.icon).toBeTypeOf('string');
    });

    it('should have color scheme', () => {
      const branding: BrandingConfig = PRODUCT_IDENTITY.branding;
      
      expect(branding.colors).toBeDefined();
      expect(branding.colors.primary).toBeTypeOf('string');
      expect(branding.colors.secondary).toBeTypeOf('string');
      expect(branding.colors.accent).toBeTypeOf('string');
      expect(branding.colors.success).toBeTypeOf('string');
      expect(branding.colors.warning).toBeTypeOf('string');
      expect(branding.colors.error).toBeTypeOf('string');
      expect(branding.colors.background).toBeTypeOf('string');
      expect(branding.colors.text).toBeTypeOf('string');
    });

    it('should have typography', () => {
      const branding: BrandingConfig = PRODUCT_IDENTITY.branding;
      
      expect(branding.typography).toBeDefined();
      expect(branding.typography.fontFamily).toBeTypeOf('string');
      expect(branding.typography.fontFamilyMono).toBeTypeOf('string');
    });
  });

  describe('ColorScheme', () => {
    it('should have all required color properties', () => {
      const colors: ColorScheme = PRODUCT_IDENTITY.branding.colors;
      
      const requiredColors: Array<keyof ColorScheme> = [
        'primary',
        'secondary',
        'accent',
        'success',
        'warning',
        'error',
        'background',
        'text',
      ];

      requiredColors.forEach(color => {
        expect(colors).toHaveProperty(color);
        expect(colors[color]).toBeTypeOf('string');
      });
    });

    it('should have valid hex color format', () => {
      const colors: ColorScheme = PRODUCT_IDENTITY.branding.colors;
      const hexPattern = /^#[0-9A-Fa-f]{6}$/;

      Object.values(colors).forEach(color => {
        expect(color).toMatch(hexPattern);
      });
    });
  });

  describe('Typography', () => {
    it('should have font families', () => {
      const typography: Typography = PRODUCT_IDENTITY.branding.typography;
      
      expect(typography.fontFamily).toBeTypeOf('string');
      expect(typography.fontFamilyMono).toBeTypeOf('string');
    });

    it('should not be empty', () => {
      const typography: Typography = PRODUCT_IDENTITY.branding.typography;
      
      expect(typography.fontFamily.length).toBeGreaterThan(0);
      expect(typography.fontFamilyMono.length).toBeGreaterThan(0);
    });
  });

  describe('URLs', () => {
    it('should have all required URLs', () => {
      const urls: URLs = PRODUCT_IDENTITY.urls;
      
      expect(urls.website).toBeTypeOf('string');
      expect(urls.docs).toBeTypeOf('string');
      expect(urls.repository).toBeTypeOf('string');
      expect(urls.issues).toBeTypeOf('string');
      expect(urls.support).toBeTypeOf('string');
    });

    it('should have valid URL formats', () => {
      const urls: URLs = PRODUCT_IDENTITY.urls;
      
      expect(urls.website).toMatch(/^https?:\/\//);
      expect(urls.docs).toMatch(/^https?:\/\//);
      expect(urls.repository).toMatch(/^https?:\/\//);
      expect(urls.issues).toMatch(/^https?:\/\//);
      expect(urls.support).toMatch(/^mailto:/);
    });
  });

  describe('Legal', () => {
    it('should have all required legal information', () => {
      const legal: Legal = PRODUCT_IDENTITY.legal;
      
      expect(legal.license).toBeTypeOf('string');
      expect(legal.copyright).toBeTypeOf('string');
      expect(legal.privacy).toBeTypeOf('string');
      expect(legal.terms).toBeTypeOf('string');
    });

    it('should have valid license', () => {
      const legal: Legal = PRODUCT_IDENTITY.legal;
      
      expect(legal.license).toBe('MIT');
    });

    it('should have valid copyright', () => {
      const legal: Legal = PRODUCT_IDENTITY.legal;
      
      expect(legal.copyright).toContain('©');
      expect(legal.copyright).toContain('2026');
    });
  });

  describe('TitaniumClawsConfig', () => {
    it('should accept minimal config', () => {
      const config: TitaniumClawsConfig = {
        version: '1.0.0',
      };

      expect(config.version).toBe('1.0.0');
    });

    it('should accept config with optional fields', () => {
      const config: TitaniumClawsConfig = {
        version: '1.0.0',
        gateway: {
          port: 18789,
          host: 'localhost',
          auth: {
            mode: 'token',
            token: 'test-token',
          },
        },
        agents: {
          fleet: {
            enabled: true,
            agents: ['PRIME', 'RESEARCH', 'CODE'],
          },
          coordination: {
            protocol: 'a2a',
          },
        },
        memory: {
          backend: 'builtin',
          vector: {
            engine: 'hnsw',
            dimensions: 1536,
          },
          text: {
            engine: 'tantivy',
            tokenizer: 'default',
          },
        },
        monitoring: {
          enabled: true,
          metrics: {
            prometheus: {
              enabled: true,
              port: 9090,
            },
          },
          logging: {
            level: 'info',
            format: 'json',
          },
        },
      };

      expect(config.version).toBe('1.0.0');
      expect(config.gateway?.port).toBe(18789);
      expect(config.agents?.fleet?.enabled).toBe(true);
      expect(config.memory?.backend).toBe('builtin');
      expect(config.monitoring?.enabled).toBe(true);
    });
  });

  describe('ResolvedPaths', () => {
    it('should have all required path properties', () => {
      const paths: ResolvedPaths = {
        stateDirectory: '/home/user/.titanium-claws',
        configPath: '/home/user/.titanium-claws/titanium-claws.json',
        databasePath: '/home/user/.titanium-claws/titanium-claws.sqlite',
        logPath: '/home/user/.titanium-claws/titanium-claws.log',
        cachePath: '/home/user/.titanium-claws/cache',
        tempPath: '/home/user/.titanium-claws/temp',
        pluginsPath: '/home/user/.titanium-claws/plugins',
        workspacePath: '/home/user/.titanium-claws/workspace',
      };

      expect(paths.stateDirectory).toBeTypeOf('string');
      expect(paths.configPath).toBeTypeOf('string');
      expect(paths.databasePath).toBeTypeOf('string');
      expect(paths.logPath).toBeTypeOf('string');
      expect(paths.cachePath).toBeTypeOf('string');
      expect(paths.tempPath).toBeTypeOf('string');
      expect(paths.pluginsPath).toBeTypeOf('string');
      expect(paths.workspacePath).toBeTypeOf('string');
    });
  });

  describe('ResolvedEnvironment', () => {
    it('should accept empty environment', () => {
      const env: ResolvedEnvironment = {};

      expect(env.stateDir).toBeUndefined();
      expect(env.configPath).toBeUndefined();
      expect(env.gatewayToken).toBeUndefined();
    });

    it('should accept partial environment', () => {
      const env: ResolvedEnvironment = {
        stateDir: '/home/user/.titanium-claws',
        gatewayToken: 'test-token',
        logLevel: 'info',
      };

      expect(env.stateDir).toBe('/home/user/.titanium-claws');
      expect(env.gatewayToken).toBe('test-token');
      expect(env.logLevel).toBe('info');
      expect(env.configPath).toBeUndefined();
    });

    it('should accept full environment', () => {
      const env: ResolvedEnvironment = {
        stateDir: '/home/user/.titanium-claws',
        configPath: '/home/user/.titanium-claws/titanium-claws.json',
        gatewayToken: 'test-token',
        gatewayPassword: 'test-password',
        logLevel: 'info',
        databaseUrl: 'sqlite:///home/user/.titanium-claws/db.sqlite',
        redisUrl: 'redis://localhost:6379',
      };

      expect(env.stateDir).toBeTypeOf('string');
      expect(env.configPath).toBeTypeOf('string');
      expect(env.gatewayToken).toBeTypeOf('string');
      expect(env.gatewayPassword).toBeTypeOf('string');
      expect(env.logLevel).toBeTypeOf('string');
      expect(env.databaseUrl).toBeTypeOf('string');
      expect(env.redisUrl).toBeTypeOf('string');
    });
  });

  describe('ValidationResult', () => {
    it('should accept valid result', () => {
      const result: ValidationResult = {
        valid: true,
        errors: [],
      };

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept invalid result with errors', () => {
      const result: ValidationResult = {
        valid: false,
        errors: [
          {
            path: ['version'],
            message: 'Missing required field',
            code: 'MISSING_REQUIRED_FIELD',
          },
        ],
      };

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toEqual(['version']);
      expect(result.errors[0].message).toBeTypeOf('string');
    });
  });

  describe('Type Guards', () => {
    it('should validate ProductIdentity structure', () => {
      const isValid = (obj: unknown): obj is ProductIdentity => {
        return (
          typeof obj === 'object' &&
          obj !== null &&
          'displayName' in obj &&
          'executable' in obj &&
          'version' in obj
        );
      };

      expect(isValid(PRODUCT_IDENTITY)).toBe(true);
      expect(isValid({})).toBe(false);
      expect(isValid(null)).toBe(false);
    });

    it('should validate LegacyIdentity structure', () => {
      const isValid = (obj: unknown): obj is LegacyIdentity => {
        return (
          typeof obj === 'object' &&
          obj !== null &&
          'displayName' in obj &&
          'executable' in obj &&
          'version' in obj
        );
      };

      expect(isValid(LEGACY_IDENTITY)).toBe(true);
      expect(isValid({})).toBe(false);
    });
  });
});

// Helper for type checking
function expect<T>(actual: T) {
  return {
    toBeTypeOf: (type: string) => {
      expect(typeof actual).toBe(type);
    },
    toHaveProperty: (prop: string) => {
      expect(actual).toHaveProperty(prop);
    },
    toMatch: (pattern: RegExp) => {
      expect(actual).toMatch(pattern);
    },
    toBe: (expected: T) => {
      expect(actual).toBe(expected);
    },
    toBeGreaterThan: (expected: number) => {
      expect(actual).toBeGreaterThan(expected);
    },
    toHaveLength: (expected: number) => {
      expect((actual as any).length).toBe(expected);
    },
    toEqual: (expected: unknown) => {
      expect(actual).toEqual(expected);
    },
    toBeUndefined: () => {
      expect(actual).toBeUndefined();
    },
  };
}
