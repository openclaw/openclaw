/**
 * Titanium Claws Environment Resolver Tests
 * 
 * Comprehensive test suite for EnvironmentResolver
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EnvironmentResolver,
  getEnvironmentResolver,
  resetEnvironmentResolver,
} from './environment-resolver.js';
import { PathResolver } from './path-resolver.js';
import { IdentityErrorCode } from './errors.js';

describe('EnvironmentResolver', () => {
  let resolver: EnvironmentResolver;
  let mockEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockEnv = {};
    resolver = new EnvironmentResolver({ env: mockEnv });
  });

  afterEach(() => {
    resolver.clearCache();
    resetEnvironmentResolver();
  });

  describe('constructor', () => {
    it('should create resolver with default options', () => {
      const resolver = new EnvironmentResolver();
      expect(resolver).toBeInstanceOf(EnvironmentResolver);
    });

    it('should accept custom environment object', () => {
      const customEnv = { TEST_VAR: 'test' };
      const resolver = new EnvironmentResolver({ env: customEnv });
      expect(resolver).toBeInstanceOf(EnvironmentResolver);
    });

    it('should accept validateOnInit option', () => {
      const resolver = new EnvironmentResolver({ validateOnInit: true });
      expect(resolver).toBeInstanceOf(EnvironmentResolver);
    });

    it('should accept custom PathResolver', () => {
      const pathResolver = new PathResolver();
      const resolver = new EnvironmentResolver({ pathResolver });
      expect(resolver).toBeInstanceOf(EnvironmentResolver);
    });
  });

  describe('get', () => {
    it('should get string environment variable', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      expect(value).toBe('debug');
    });

    it('should get number environment variable', () => {
      mockEnv.TITANIUM_CLAWS_PORT = '8080';
      const value = resolver.get(EnvironmentResolver.CONFIG_PORT);
      expect(value).toBe(8080);
    });

    it('should get boolean environment variable', () => {
      mockEnv.TITANIUM_CLAWS_DEBUG = 'true';
      const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
      expect(value).toBe(true);
    });

    it('should get path environment variable', () => {
      mockEnv.TITANIUM_CLAWS_STATE_DIR = '~/state';
      const value = resolver.get(EnvironmentResolver.PATH_STATE_DIR);
      expect(value).toContain('state');
    });

    it('should return default value when variable not set', () => {
      const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      expect(value).toBe('info');
    });

    it('should return undefined when optional variable not set', () => {
      const value = resolver.get(EnvironmentResolver.PATH_STATE_DIR);
      expect(value).toBeUndefined();
    });

    it('should throw error when required variable not set', () => {
      const requiredVar = {
        name: 'REQUIRED_VAR',
        type: 'string' as const,
        required: true,
        description: 'Required variable',
      };
      
      expect(() => resolver.get(requiredVar)).toThrow();
    });

    it('should cache retrieved values', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      
      const value1 = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      const value2 = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      
      expect(value1).toBe(value2);
    });

    it('should validate values with custom validator', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'invalid';
      
      expect(() => resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL)).toThrow();
    });
  });

  describe('getOrDefault', () => {
    it('should return value when set', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      const value = resolver.getOrDefault(EnvironmentResolver.CONFIG_LOG_LEVEL, 'info');
      expect(value).toBe('debug');
    });

    it('should return default when not set', () => {
      const value = resolver.getOrDefault(EnvironmentResolver.PATH_STATE_DIR, '/default');
      expect(value).toBe('/default');
    });

    it('should return default when validation fails', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'invalid';
      const value = resolver.getOrDefault(EnvironmentResolver.CONFIG_LOG_LEVEL, 'info');
      expect(value).toBe('info');
    });
  });

  describe('has', () => {
    it('should return true when variable is set', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      expect(resolver.has(EnvironmentResolver.CONFIG_LOG_LEVEL)).toBe(true);
    });

    it('should return false when variable is not set', () => {
      expect(resolver.has(EnvironmentResolver.CONFIG_LOG_LEVEL)).toBe(false);
    });
  });

  describe('getPaths', () => {
    it('should return all path variables', () => {
      mockEnv.TITANIUM_CLAWS_STATE_DIR = '~/state';
      mockEnv.TITANIUM_CLAWS_CONFIG_PATH = '~/config';
      
      const paths = resolver.getPaths();
      
      expect(paths).toHaveProperty('TITANIUM_CLAWS_STATE_DIR');
      expect(paths).toHaveProperty('TITANIUM_CLAWS_CONFIG_PATH');
      expect(Object.keys(paths).length).toBe(8);
    });
  });

  describe('getConfig', () => {
    it('should return all config variables', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      mockEnv.TITANIUM_CLAWS_PORT = '8080';
      
      const config = resolver.getConfig();
      
      expect(config).toHaveProperty('TITANIUM_CLAWS_LOG_LEVEL');
      expect(config).toHaveProperty('TITANIUM_CLAWS_PORT');
      expect(Object.keys(config).length).toBe(4);
    });
  });

  describe('getProviders', () => {
    it('should return all provider API keys', () => {
      mockEnv.ANTHROPIC_API_KEY = 'test-key';
      mockEnv.OPENAI_API_KEY = 'test-key';
      
      const providers = resolver.getProviders();
      
      expect(providers).toHaveProperty('ANTHROPIC_API_KEY');
      expect(providers).toHaveProperty('OPENAI_API_KEY');
      expect(Object.keys(providers).length).toBe(3);
    });
  });

  describe('getFeatures', () => {
    it('should return all feature flags', () => {
      mockEnv.TITANIUM_CLAWS_FEATURE_RUST_ENGINES = 'true';
      
      const features = resolver.getFeatures();
      
      expect(features).toHaveProperty('TITANIUM_CLAWS_FEATURE_RUST_ENGINES');
      expect(features.TITANIUM_CLAWS_FEATURE_RUST_ENGINES).toBe(true);
      expect(Object.keys(features).length).toBe(4);
    });
  });

  describe('getAll', () => {
    it('should return all environment variables', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      mockEnv.TITANIUM_CLAWS_PORT = '8080';
      
      const all = resolver.getAll();
      
      expect(Object.keys(all).length).toBe(EnvironmentResolver.ALL_VARIABLES.length);
    });
  });

  describe('validate', () => {
    it('should validate valid variable', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      expect(resolver.validate(EnvironmentResolver.CONFIG_LOG_LEVEL)).toBe(true);
    });

    it('should validate invalid variable', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'invalid';
      expect(resolver.validate(EnvironmentResolver.CONFIG_LOG_LEVEL)).toBe(false);
    });

    it('should validate missing optional variable', () => {
      expect(resolver.validate(EnvironmentResolver.PATH_STATE_DIR)).toBe(true);
    });

    it('should cache validation results', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      
      const result1 = resolver.validate(EnvironmentResolver.CONFIG_LOG_LEVEL);
      const result2 = resolver.validate(EnvironmentResolver.CONFIG_LOG_LEVEL);
      
      expect(result1).toBe(result2);
    });
  });

  describe('validateAll', () => {
    it('should validate all variables', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      mockEnv.TITANIUM_CLAWS_PORT = '8080';
      
      const result = resolver.validateAll();
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should report errors for invalid variables', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'invalid';
      
      const result = resolver.validateAll();
      
      expect(result.valid).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('validateGroup', () => {
    it('should validate path group', () => {
      mockEnv.TITANIUM_CLAWS_STATE_DIR = '~/state';
      
      const result = resolver.validateGroup('paths');
      
      expect(result.valid).toBe(true);
    });

    it('should validate config group', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      
      const result = resolver.validateGroup('config');
      
      expect(result.valid).toBe(true);
    });

    it('should report error for unknown group', () => {
      const result = resolver.validateGroup('unknown');
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Unknown group: unknown');
    });
  });

  describe('getGroup', () => {
    it('should return group by name', () => {
      const group = resolver.getGroup('paths');
      
      expect(group).toBeDefined();
      expect(group?.name).toBe('paths');
    });

    it('should return undefined for unknown group', () => {
      const group = resolver.getGroup('unknown');
      
      expect(group).toBeUndefined();
    });
  });

  describe('getGroups', () => {
    it('should return all groups', () => {
      const groups = resolver.getGroups();
      
      expect(groups).toHaveLength(4);
      expect(groups[0].name).toBe('paths');
      expect(groups[1].name).toBe('config');
      expect(groups[2].name).toBe('providers');
      expect(groups[3].name).toBe('features');
    });
  });

  describe('clearCache', () => {
    it('should clear cache', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      
      resolver.clearCache();
      
      // Should re-fetch from environment
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'info';
      const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      
      expect(value).toBe('info');
    });
  });

  describe('exportAsJson', () => {
    it('should export as JSON', () => {
      const json = resolver.exportAsJson();
      
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should include all required fields', () => {
      const json = resolver.exportAsJson();
      const parsed = JSON.parse(json);
      
      expect(parsed).toHaveProperty('variables');
      expect(parsed).toHaveProperty('validation');
      expect(parsed).toHaveProperty('groups');
    });
  });

  describe('formatForDisplay', () => {
    it('should format for display', () => {
      const formatted = resolver.formatForDisplay();
      
      expect(formatted).toContain('Environment Variables:');
      expect(formatted).toContain('[PATHS]');
      expect(formatted).toContain('[CONFIG]');
      expect(formatted).toContain('[PROVIDERS]');
      expect(formatted).toContain('[FEATURES]');
    });
  });

  describe('parseValue', () => {
    it('should parse string values', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = 'debug';
      const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      expect(typeof value).toBe('string');
    });

    it('should parse number values', () => {
      mockEnv.TITANIUM_CLAWS_PORT = '8080';
      const value = resolver.get(EnvironmentResolver.CONFIG_PORT);
      expect(typeof value).toBe('number');
    });

    it('should parse boolean true values', () => {
      mockEnv.TITANIUM_CLAWS_DEBUG = 'true';
      const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
      expect(value).toBe(true);
    });

    it('should parse boolean false values', () => {
      mockEnv.TITANIUM_CLAWS_DEBUG = 'false';
      const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
      expect(value).toBe(false);
    });

    it('should parse boolean 1 values', () => {
      mockEnv.TITANIUM_CLAWS_DEBUG = '1';
      const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
      expect(value).toBe(true);
    });

    it('should throw error for invalid number', () => {
      mockEnv.TITANIUM_CLAWS_PORT = 'invalid';
      expect(() => resolver.get(EnvironmentResolver.CONFIG_PORT)).toThrow();
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance', () => {
      const instance1 = getEnvironmentResolver();
      const instance2 = getEnvironmentResolver();
      
      expect(instance1).toBe(instance2);
    });

    it('should reset singleton', () => {
      const instance1 = getEnvironmentResolver();
      resetEnvironmentResolver();
      const instance2 = getEnvironmentResolver();
      
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('static definitions', () => {
    it('should have all path variables defined', () => {
      expect(EnvironmentResolver.PATH_STATE_DIR).toBeDefined();
      expect(EnvironmentResolver.PATH_CONFIG_PATH).toBeDefined();
      expect(EnvironmentResolver.PATH_DATABASE_PATH).toBeDefined();
      expect(EnvironmentResolver.PATH_LOG_PATH).toBeDefined();
      expect(EnvironmentResolver.PATH_CACHE_PATH).toBeDefined();
      expect(EnvironmentResolver.PATH_TEMP_PATH).toBeDefined();
      expect(EnvironmentResolver.PATH_PLUGINS_PATH).toBeDefined();
      expect(EnvironmentResolver.PATH_WORKSPACE_PATH).toBeDefined();
    });

    it('should have all config variables defined', () => {
      expect(EnvironmentResolver.CONFIG_LOG_LEVEL).toBeDefined();
      expect(EnvironmentResolver.CONFIG_DEBUG).toBeDefined();
      expect(EnvironmentResolver.CONFIG_ENVIRONMENT).toBeDefined();
      expect(EnvironmentResolver.CONFIG_PORT).toBeDefined();
    });

    it('should have all provider variables defined', () => {
      expect(EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY).toBeDefined();
      expect(EnvironmentResolver.PROVIDER_OPENAI_API_KEY).toBeDefined();
      expect(EnvironmentResolver.PROVIDER_GOOGLE_API_KEY).toBeDefined();
    });

    it('should have all feature variables defined', () => {
      expect(EnvironmentResolver.FEATURE_RUST_ENGINES).toBeDefined();
      expect(EnvironmentResolver.FEATURE_MULTI_AGENT).toBeDefined();
      expect(EnvironmentResolver.FEATURE_A2A_PROTOCOL).toBeDefined();
      expect(EnvironmentResolver.FEATURE_CAUSAL_GRAPH).toBeDefined();
    });

    it('should have ALL_VARIABLES array', () => {
      expect(EnvironmentResolver.ALL_VARIABLES).toBeDefined();
      expect(EnvironmentResolver.ALL_VARIABLES.length).toBe(19);
    });

    it('should have GROUPS array', () => {
      expect(EnvironmentResolver.GROUPS).toBeDefined();
      expect(EnvironmentResolver.GROUPS.length).toBe(4);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string values', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = '';
      const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      expect(value).toBe('');
    });

    it('should handle whitespace values', () => {
      mockEnv.TITANIUM_CLAWS_LOG_LEVEL = '  debug  ';
      const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      expect(value).toBe('  debug  ');
    });

    it('should handle case-insensitive boolean', () => {
      mockEnv.TITANIUM_CLAWS_DEBUG = 'TRUE';
      const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
      expect(value).toBe(true);
    });

    it('should handle mixed case boolean', () => {
      mockEnv.TITANIUM_CLAWS_DEBUG = 'True';
      const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
      expect(value).toBe(true);
    });
  });

  describe('performance', () => {
    it('should cache values efficiently', () => {
      const iterations = 1000;
      const startTime = Date.now();
      
      for (let i = 0; i < iterations; i++) {
        resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
      }
      
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(100);
    });
  });
});
