/**
 * Tests for Identity Layer constants
 */

import { describe, it, expect } from 'vitest';
import {
  PRODUCT_IDENTITY,
  LEGACY_IDENTITY,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_TYPOGRAPHY,
  ENVIRONMENT_VARIABLES,
  LEGACY_ENVIRONMENT_VARIABLES,
  SUPPORTED_PLATFORMS,
  SUPPORTED_NODE_VERSIONS,
  FEATURE_FLAGS,
} from '../constants.js';

describe('Identity Constants', () => {
  describe('PRODUCT_IDENTITY', () => {
    it('should have correct display name', () => {
      expect(PRODUCT_IDENTITY.displayName).toBe('Titanium Claws');
    });

    it('should have correct short name', () => {
      expect(PRODUCT_IDENTITY.shortName).toBe('Titanium');
    });

    it('should have correct tagline', () => {
      expect(PRODUCT_IDENTITY.tagline).toBe('Rust-Powered Multi-Agent Intelligence');
    });

    it('should have correct executable', () => {
      expect(PRODUCT_IDENTITY.executable).toBe('tc');
    });

    it('should have correct full executable', () => {
      expect(PRODUCT_IDENTITY.executableFull).toBe('titanium-claws');
    });

    it('should have correct package scope', () => {
      expect(PRODUCT_IDENTITY.packageScope).toBe('@titanium-claws');
    });

    it('should have correct repository', () => {
      expect(PRODUCT_IDENTITY.repository).toBe('titanium-claws/titanium-claws');
    });

    it('should have correct state directory', () => {
      expect(PRODUCT_IDENTITY.stateDirectory).toBe('.titanium-claws');
    });

    it('should have correct config file', () => {
      expect(PRODUCT_IDENTITY.configFile).toBe('titanium-claws.json');
    });

    it('should have correct database file', () => {
      expect(PRODUCT_IDENTITY.databaseFile).toBe('titanium-claws.sqlite');
    });

    it('should have correct log file', () => {
      expect(PRODUCT_IDENTITY.logFile).toBe('titanium-claws.log');
    });

    it('should have correct environment prefix', () => {
      expect(PRODUCT_IDENTITY.envPrefix).toBe('TITANIUM_CLAWS');
    });

    it('should have valid version format', () => {
      expect(PRODUCT_IDENTITY.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have branding configuration', () => {
      expect(PRODUCT_IDENTITY.branding).toBeDefined();
      expect(PRODUCT_IDENTITY.branding.logo).toBeDefined();
      expect(PRODUCT_IDENTITY.branding.colors).toBeDefined();
      expect(PRODUCT_IDENTITY.branding.typography).toBeDefined();
    });

    it('should have URLs', () => {
      expect(PRODUCT_IDENTITY.urls).toBeDefined();
      expect(PRODUCT_IDENTITY.urls.website).toMatch(/^https:\/\//);
      expect(PRODUCT_IDENTITY.urls.docs).toMatch(/^https:\/\//);
      expect(PRODUCT_IDENTITY.urls.repository).toMatch(/^https:\/\//);
    });

    it('should have legal information', () => {
      expect(PRODUCT_IDENTITY.legal).toBeDefined();
      expect(PRODUCT_IDENTITY.legal.license).toBe('MIT');
      expect(PRODUCT_IDENTITY.legal.copyright).toContain('2026');
    });
  });

  describe('LEGACY_IDENTITY', () => {
    it('should have correct display name', () => {
      expect(LEGACY_IDENTITY.displayName).toBe('OpenClaw');
    });

    it('should have correct executable', () => {
      expect(LEGACY_IDENTITY.executable).toBe('openclaw');
    });

    it('should have correct package scope', () => {
      expect(LEGACY_IDENTITY.packageScope).toBe('@openclaw');
    });

    it('should have correct repository', () => {
      expect(LEGACY_IDENTITY.repository).toBe('openclaw/openclaw');
    });

    it('should have correct state directory', () => {
      expect(LEGACY_IDENTITY.stateDirectory).toBe('.openclaw');
    });

    it('should have correct config file', () => {
      expect(LEGACY_IDENTITY.configFile).toBe('openclaw.json');
    });

    it('should have correct environment prefix', () => {
      expect(LEGACY_IDENTITY.envPrefix).toBe('OPENCLAW');
    });

    it('should have legal information', () => {
      expect(LEGACY_IDENTITY.legal).toBeDefined();
      expect(LEGACY_IDENTITY.legal.license).toBe('MIT');
    });
  });

  describe('DEFAULT_COLOR_SCHEME', () => {
    it('should have all required colors', () => {
      expect(DEFAULT_COLOR_SCHEME.primary).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.secondary).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.accent).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.success).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.warning).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.error).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.background).toBeDefined();
      expect(DEFAULT_COLOR_SCHEME.text).toBeDefined();
    });

    it('should have valid hex colors', () => {
      const hexPattern = /^#[0-9A-Fa-f]{6}$/;
      expect(DEFAULT_COLOR_SCHEME.primary).toMatch(hexPattern);
      expect(DEFAULT_COLOR_SCHEME.secondary).toMatch(hexPattern);
      expect(DEFAULT_COLOR_SCHEME.accent).toMatch(hexPattern);
    });

    it('should be frozen', () => {
      expect(Object.isFrozen(DEFAULT_COLOR_SCHEME)).toBe(true);
    });
  });

  describe('DEFAULT_TYPOGRAPHY', () => {
    it('should have font family', () => {
      expect(DEFAULT_TYPOGRAPHY.fontFamily).toBeDefined();
      expect(DEFAULT_TYPOGRAPHY.fontFamily).toContain('Inter');
    });

    it('should have monospace font family', () => {
      expect(DEFAULT_TYPOGRAPHY.fontFamilyMono).toBeDefined();
      expect(DEFAULT_TYPOGRAPHY.fontFamilyMono).toContain('JetBrains Mono');
    });

    it('should be frozen', () => {
      expect(Object.isFrozen(DEFAULT_TYPOGRAPHY)).toBe(true);
    });
  });

  describe('ENVIRONMENT_VARIABLES', () => {
    it('should have all required variables', () => {
      expect(ENVIRONMENT_VARIABLES.STATE_DIR).toBeDefined();
      expect(ENVIRONMENT_VARIABLES.CONFIG_PATH).toBeDefined();
      expect(ENVIRONMENT_VARIABLES.GATEWAY_TOKEN).toBeDefined();
      expect(ENVIRONMENT_VARIABLES.GATEWAY_PASSWORD).toBeDefined();
      expect(ENVIRONMENT_VARIABLES.LOG_LEVEL).toBeDefined();
      expect(ENVIRONMENT_VARIABLES.DATABASE_URL).toBeDefined();
      expect(ENVIRONMENT_VARIABLES.REDIS_URL).toBeDefined();
    });

    it('should have correct prefix', () => {
      expect(ENVIRONMENT_VARIABLES.STATE_DIR).toMatch(/^TITANIUM_CLAWS_/);
      expect(ENVIRONMENT_VARIABLES.CONFIG_PATH).toMatch(/^TITANIUM_CLAWS_/);
      expect(ENVIRONMENT_VARIABLES.GATEWAY_TOKEN).toMatch(/^TITANIUM_CLAWS_/);
    });
  });

  describe('LEGACY_ENVIRONMENT_VARIABLES', () => {
    it('should have all required variables', () => {
      expect(LEGACY_ENVIRONMENT_VARIABLES.STATE_DIR).toBeDefined();
      expect(LEGACY_ENVIRONMENT_VARIABLES.CONFIG_PATH).toBeDefined();
      expect(LEGACY_ENVIRONMENT_VARIABLES.GATEWAY_TOKEN).toBeDefined();
      expect(LEGACY_ENVIRONMENT_VARIABLES.GATEWAY_PASSWORD).toBeDefined();
      expect(LEGACY_ENVIRONMENT_VARIABLES.LOG_LEVEL).toBeDefined();
      expect(LEGACY_ENVIRONMENT_VARIABLES.DATABASE_URL).toBeDefined();
      expect(LEGACY_ENVIRONMENT_VARIABLES.REDIS_URL).toBeDefined();
    });

    it('should have correct prefix', () => {
      expect(LEGACY_ENVIRONMENT_VARIABLES.STATE_DIR).toMatch(/^OPENCLAW_/);
      expect(LEGACY_ENVIRONMENT_VARIABLES.CONFIG_PATH).toMatch(/^OPENCLAW_/);
      expect(LEGACY_ENVIRONMENT_VARIABLES.GATEWAY_TOKEN).toMatch(/^OPENCLAW_/);
    });
  });

  describe('SUPPORTED_PLATFORMS', () => {
    it('should support macOS Intel', () => {
      expect(SUPPORTED_PLATFORMS).toContain('darwin-x64');
    });

    it('should support macOS Apple Silicon', () => {
      expect(SUPPORTED_PLATFORMS).toContain('darwin-arm64');
    });

    it('should support Linux x64', () => {
      expect(SUPPORTED_PLATFORMS).toContain('linux-x64');
    });

    it('should support Linux ARM64', () => {
      expect(SUPPORTED_PLATFORMS).toContain('linux-arm64');
    });

    it('should support Windows x64', () => {
      expect(SUPPORTED_PLATFORMS).toContain('win32-x64');
    });
  });

  describe('SUPPORTED_NODE_VERSIONS', () => {
    it('should have minimum version', () => {
      expect(SUPPORTED_NODE_VERSIONS.minimum).toBeDefined();
      expect(SUPPORTED_NODE_VERSIONS.minimum).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have recommended version', () => {
      expect(SUPPORTED_NODE_VERSIONS.recommended).toBeDefined();
      expect(SUPPORTED_NODE_VERSIONS.recommended).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have maximum version', () => {
      expect(SUPPORTED_NODE_VERSIONS.maximum).toBeDefined();
      expect(SUPPORTED_NODE_VERSIONS.maximum).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('FEATURE_FLAGS', () => {
    it('should enable Rust engines', () => {
      expect(FEATURE_FLAGS.RUST_ENGINES).toBe(true);
    });

    it('should enable multi-agent', () => {
      expect(FEATURE_FLAGS.MULTI_AGENT).toBe(true);
    });

    it('should enable A2A protocol', () => {
      expect(FEATURE_FLAGS.A2A_PROTOCOL).toBe(true);
    });

    it('should enable causal graph', () => {
      expect(FEATURE_FLAGS.CAUSAL_GRAPH).toBe(true);
    });

    it('should enable backward compatibility', () => {
      expect(FEATURE_FLAGS.BACKWARD_COMPATIBILITY).toBe(true);
    });
  });
});
