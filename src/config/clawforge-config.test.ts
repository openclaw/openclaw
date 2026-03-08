/**
 * ClawForge 配置加载器单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  loadRuntimeConfigFromEnv,
  validateWorkspacePath,
  buildWorkspacePath,
  mergeConfig,
  getRunMode,
} from './clawforge-config.js';

describe('ClawForge Config', () => {
  describe('loadRuntimeConfigFromEnv', () => {
    it('should load runtime config from environment variables', () => {
      const env = {
        ORG_ID: 'org_test123',
        USER_ID: 'user_abc456',
        WORKSPACE: '/storage/org_test123/user_abc456/workspace',
        QDRANT_HOST: 'qdrant.example.com',
        QDRANT_PORT: '6333',
        QDRANT_API_KEY: 'qdrant_key_xyz',
        EMBEDDING_API_KEY: 'emb_key_123',
        LLM_API_KEY: 'llm_key_456',
      };

      const config = loadRuntimeConfigFromEnv(env);

      expect(config).not.toBeNull();
      expect(config!.orgId).toBe('org_test123');
      expect(config!.userId).toBe('user_abc456');
      expect(config!.workspace).toBe('/storage/org_test123/user_abc456/workspace');
      expect(config!.memoryStore).toEqual({
        provider: 'qdrant',
        host: 'qdrant.example.com',
        port: 6333,
        apiKey: 'qdrant_key_xyz',
        tenantId: 'org_test123',
      });
      expect(config!.apiKeys).toEqual({
        embedding: 'emb_key_123',
        llm: 'llm_key_456',
        reranker: undefined,
      });
    });

    it('should return null when ORG_ID is missing', () => {
      const env = {
        USER_ID: 'user_abc456',
        WORKSPACE: '/storage/workspace',
      };

      const config = loadRuntimeConfigFromEnv(env);
      expect(config).toBeNull();
    });

    it('should return null when USER_ID is missing', () => {
      const env = {
        ORG_ID: 'org_test123',
        WORKSPACE: '/storage/workspace',
      };

      const config = loadRuntimeConfigFromEnv(env);
      expect(config).toBeNull();
    });

    it('should throw error when WORKSPACE is missing but ORG_ID/USER_ID provided', () => {
      const env = {
        ORG_ID: 'org_test123',
        USER_ID: 'user_abc456',
      };

      expect(() => loadRuntimeConfigFromEnv(env)).toThrow(
        'ClawForge 配置错误：提供了 ORG_ID/USER_ID 但未提供 WORKSPACE 环境变量'
      );
    });

    it('should use default Qdrant port when not specified', () => {
      const env = {
        ORG_ID: 'org_test123',
        USER_ID: 'user_abc456',
        WORKSPACE: '/storage/org_test123/user_abc456/workspace',
        QDRANT_HOST: 'qdrant.example.com',
      };

      const config = loadRuntimeConfigFromEnv(env);
      expect(config!.memoryStore!.port).toBe(6333);
    });

    it('should work without optional API keys', () => {
      const env = {
        ORG_ID: 'org_test123',
        USER_ID: 'user_abc456',
        WORKSPACE: '/storage/org_test123/user_abc456/workspace',
      };

      const config = loadRuntimeConfigFromEnv(env);
      expect(config!.apiKeys).toEqual({
        embedding: undefined,
        llm: undefined,
        reranker: undefined,
      });
    });
  });

  describe('validateWorkspacePath', () => {
    it('should validate correct workspace path', () => {
      const valid = validateWorkspacePath(
        '/storage/org_test123/user_abc456/workspace',
        'org_test123',
        'user_abc456'
      );
      expect(valid).toBe(true);
    });

    it('should reject path without orgId', () => {
      const valid = validateWorkspacePath(
        '/storage/user_abc456/workspace',
        'org_test123',
        'user_abc456'
      );
      expect(valid).toBe(false);
    });

    it('should reject path with parent directory traversal', () => {
      const valid = validateWorkspacePath(
        '/storage/../etc/passwd',
        'org_test123',
        'user_abc456'
      );
      expect(valid).toBe(false);
    });

    it('should warn when path does not match expected pattern', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const valid = validateWorkspacePath(
        '/storage/different_org/user_abc456/workspace',
        'org_test123',
        'user_abc456'
      );
      
      expect(valid).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalled();
      
      consoleWarnSpy.mockRestore();
    });
  });

  describe('buildWorkspacePath', () => {
    it('should build correct workspace path', () => {
      const path = buildWorkspacePath('/storage', 'org_test123', 'user_abc456');
      expect(path).toBe('/storage/org_test123/user_abc456/workspace');
    });

    it('should sanitize special characters in IDs', () => {
      const path = buildWorkspacePath('/storage', 'org@test#123', 'user!abc$456');
      expect(path).toBe('/storage/org_test_123/user_abc_456/workspace');
    });

    it('should handle nested base storage path', () => {
      const path = buildWorkspacePath('/data/clawforge/storage', 'org_123', 'user_456');
      expect(path).toBe('/data/clawforge/storage/org_123/user_456/workspace');
    });
  });

  describe('mergeConfig', () => {
    it('should merge base and runtime configs', () => {
      const baseConfig = {
        gateway: {
          port: 4000,
          token: 'test_token',
        },
        skills: {
          enabled: true,
          permissionCheck: true,
        },
      };

      const runtimeConfig = {
        orgId: 'org_test123',
        userId: 'user_abc456',
        workspace: '/storage/org_test123/user_abc456/workspace',
        apiKeys: {
          embedding: 'emb_key',
          llm: 'llm_key',
        },
      };

      const config = mergeConfig(baseConfig, runtimeConfig);

      expect(config.gateway.port).toBe(4000);
      expect(config.gateway.token).toBe('test_token');
      expect(config.runtime).toEqual(runtimeConfig);
      expect(config.skills.enabled).toBe(true);
    });

    it('should use defaults when base config is empty', () => {
      const config = mergeConfig({});

      expect(config.gateway.port).toBe(3000);
      expect(config.gateway.host).toBe('0.0.0.0');
      expect(config.skills.enabled).toBe(true);
      expect(config.skills.permissionCheck).toBe(true);
      expect(config.container.enabled).toBe(false);
    });

    it('should work without runtime config', () => {
      const config = mergeConfig({
        gateway: { port: 5000, token: 'test' },
      });

      expect(config.gateway.port).toBe(5000);
      expect(config.runtime).toBeUndefined();
    });
  });

  describe('getRunMode', () => {
    it('should return standalone mode by default', () => {
      expect(getRunMode({})).toBe('standalone');
    });

    it('should return orchestrator mode', () => {
      expect(getRunMode({ OPENCLAW_MODE: 'orchestrator' })).toBe('orchestrator');
    });

    it('should return worker mode', () => {
      expect(getRunMode({ OPENCLAW_MODE: 'worker' })).toBe('worker');
    });
  });
});
