/**
 * Titanium Claws Identity Service Tests
 * 
 * Comprehensive test suite for the IdentityService class.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  IdentityService,
  getIdentityService,
  resetIdentityService,
} from './identity-service.js';
import { PRODUCT_IDENTITY, LEGACY_IDENTITY } from './constants.js';
import { IdentityError, IdentityErrorCode } from './errors.js';

describe('IdentityService', () => {
  let service: IdentityService;

  beforeEach(() => {
    service = new IdentityService();
    resetIdentityService();
  });

  afterEach(() => {
    resetIdentityService();
  });

  describe('constructor', () => {
    it('should create service with default options', () => {
      const svc = new IdentityService();
      expect(svc).toBeInstanceOf(IdentityService);
    });

    it('should create service with custom options', () => {
      const svc = new IdentityService({
        productIdentity: { displayName: 'Custom Name' },
        legacyIdentity: { displayName: 'Legacy Custom' },
      });
      expect(svc).toBeInstanceOf(IdentityService);
    });
  });

  describe('Public Identity Methods', () => {
    describe('getDisplayName', () => {
      it('should return product display name', () => {
        expect(service.getDisplayName()).toBe(PRODUCT_IDENTITY.displayName);
      });

      it('should return overridden display name', () => {
        const svc = new IdentityService({
          productIdentity: { displayName: 'Custom Display' },
        });
        expect(svc.getDisplayName()).toBe('Custom Display');
      });
    });

    describe('getShortName', () => {
      it('should return short name', () => {
        expect(service.getShortName()).toBe(PRODUCT_IDENTITY.shortName);
      });
    });

    describe('getTagline', () => {
      it('should return tagline', () => {
        expect(service.getTagline()).toBe(PRODUCT_IDENTITY.tagline);
      });
    });

    describe('getDescription', () => {
      it('should return description', () => {
        expect(service.getDescription()).toBe(PRODUCT_IDENTITY.description);
      });
    });
  });

  describe('Technical Identity Methods', () => {
    describe('getExecutableName', () => {
      it('should return short executable name by default', () => {
        expect(service.getExecutableName()).toBe(PRODUCT_IDENTITY.executable);
      });

      it('should return full executable name when requested', () => {
        expect(service.getExecutableName({ full: true })).toBe(
          PRODUCT_IDENTITY.executableFull,
        );
      });
    });

    describe('getPackageScope', () => {
      it('should return package scope', () => {
        expect(service.getPackageScope()).toBe(PRODUCT_IDENTITY.packageScope);
      });
    });

    describe('getRepository', () => {
      it('should return repository identifier', () => {
        expect(service.getRepository()).toBe(PRODUCT_IDENTITY.repository);
      });
    });
  });

  describe('Configuration Methods', () => {
    describe('getStateDirectoryName', () => {
      it('should return state directory name', () => {
        expect(service.getStateDirectoryName()).toBe(
          PRODUCT_IDENTITY.stateDirectory,
        );
      });
    });

    describe('getConfigFileName', () => {
      it('should return config file name', () => {
        expect(service.getConfigFileName()).toBe(
          PRODUCT_IDENTITY.configFile,
        );
      });
    });

    describe('getEnvPrefix', () => {
      it('should return environment prefix', () => {
        expect(service.getEnvPrefix()).toBe(PRODUCT_IDENTITY.envPrefix);
      });
    });
  });

  describe('Versioning Methods', () => {
    describe('getVersion', () => {
      it('should return version', () => {
        expect(service.getVersion()).toBe(PRODUCT_IDENTITY.version);
      });
    });

    describe('getOpenClawCompatibilityVersion', () => {
      it('should return OpenClaw compatibility version', () => {
        expect(service.getOpenClawCompatibilityVersion()).toBe(
          PRODUCT_IDENTITY.openclawCompatibility,
        );
      });
    });

    describe('isCompatibleWithOpenClaw', () => {
      it('should return true for exact match', () => {
        expect(service.isCompatibleWithOpenClaw('2026.7.2')).toBe(true);
      });

      it('should return true for newer compatible version', () => {
        expect(service.isCompatibleWithOpenClaw('2026.8.0')).toBe(true);
      });

      it('should return false for older version', () => {
        expect(service.isCompatibleWithOpenClaw('2026.6.0')).toBe(false);
      });

      it('should return false for invalid version', () => {
        expect(service.isCompatibleWithOpenClaw('invalid')).toBe(false);
      });
    });
  });

  describe('Branding Methods', () => {
    describe('getLogoPath', () => {
      it('should return light theme logo by default', () => {
        expect(service.getLogoPath()).toBe(
          PRODUCT_IDENTITY.branding.logo.light,
        );
      });

      it('should return dark theme logo when requested', () => {
        expect(service.getLogoPath('dark')).toBe(
          PRODUCT_IDENTITY.branding.logo.dark,
        );
      });
    });

    describe('getColorScheme', () => {
      it('should return color scheme', () => {
        const colors = service.getColorScheme();
        expect(colors.primary).toBe(PRODUCT_IDENTITY.branding.colors.primary);
        expect(colors.secondary).toBe(
          PRODUCT_IDENTITY.branding.colors.secondary,
        );
        expect(colors.accent).toBe(PRODUCT_IDENTITY.branding.colors.accent);
      });
    });

    describe('getTypography', () => {
      it('should return typography configuration', () => {
        const typography = service.getTypography();
        expect(typography.fontFamily).toBe(
          PRODUCT_IDENTITY.branding.typography.fontFamily,
        );
        expect(typography.fontFamilyMono).toBe(
          PRODUCT_IDENTITY.branding.typography.fontFamilyMono,
        );
      });
    });
  });

  describe('Documentation Methods', () => {
    describe('getWebsiteUrl', () => {
      it('should return website URL', () => {
        expect(service.getWebsiteUrl()).toBe(PRODUCT_IDENTITY.urls.website);
      });
    });

    describe('getDocsUrl', () => {
      it('should return documentation URL', () => {
        expect(service.getDocsUrl()).toBe(PRODUCT_IDENTITY.urls.docs);
      });
    });

    describe('getRepositoryUrl', () => {
      it('should return repository URL', () => {
        expect(service.getRepositoryUrl()).toBe(
          PRODUCT_IDENTITY.urls.repository,
        );
      });
    });

    describe('getSupportEmail', () => {
      it('should return support email', () => {
        expect(service.getSupportEmail()).toBe(PRODUCT_IDENTITY.urls.support);
      });
    });
  });

  describe('Legal Methods', () => {
    describe('getLicense', () => {
      it('should return license type', () => {
        expect(service.getLicense()).toBe(PRODUCT_IDENTITY.legal.license);
      });
    });

    describe('getCopyright', () => {
      it('should return copyright notice', () => {
        expect(service.getCopyright()).toBe(PRODUCT_IDENTITY.legal.copyright);
      });
    });
  });

  describe('Legacy Compatibility Methods', () => {
    describe('getLegacyExecutableName', () => {
      it('should return legacy executable name', () => {
        expect(service.getLegacyExecutableName()).toBe(
          LEGACY_IDENTITY.executable,
        );
      });
    });

    describe('getLegacyPackageScope', () => {
      it('should return legacy package scope', () => {
        expect(service.getLegacyPackageScope()).toBe(
          LEGACY_IDENTITY.packageScope,
        );
      });
    });

    describe('getLegacyStateDirectoryName', () => {
      it('should return legacy state directory name', () => {
        expect(service.getLegacyStateDirectoryName()).toBe(
          LEGACY_IDENTITY.stateDirectory,
        );
      });
    });

    describe('getLegacyEnvPrefix', () => {
      it('should return legacy environment prefix', () => {
        expect(service.getLegacyEnvPrefix()).toBe(LEGACY_IDENTITY.envPrefix);
      });
    });
  });

  describe('Aggregate Methods', () => {
    describe('getProductInfo', () => {
      it('should return product information summary', () => {
        const info = service.getProductInfo();
        expect(info.displayName).toBe(PRODUCT_IDENTITY.displayName);
        expect(info.version).toBe(PRODUCT_IDENTITY.version);
        expect(info.executable).toBe(PRODUCT_IDENTITY.executable);
        expect(info.packageScope).toBe(PRODUCT_IDENTITY.packageScope);
      });

      it('should include all required fields', () => {
        const info = service.getProductInfo();
        expect(info).toHaveProperty('displayName');
        expect(info).toHaveProperty('shortName');
        expect(info).toHaveProperty('version');
        expect(info).toHaveProperty('tagline');
        expect(info).toHaveProperty('description');
        expect(info).toHaveProperty('executable');
        expect(info).toHaveProperty('packageScope');
        expect(info).toHaveProperty('repository');
        expect(info).toHaveProperty('stateDirectory');
        expect(info).toHaveProperty('configFile');
      });
    });

    describe('getBranding', () => {
      it('should return complete branding configuration', () => {
        const branding = service.getBranding();
        expect(branding.logo).toBeDefined();
        expect(branding.colors).toBeDefined();
        expect(branding.typography).toBeDefined();
      });
    });

    describe('getUrls', () => {
      it('should return documentation URLs', () => {
        const urls = service.getUrls();
        expect(urls.website).toBe(PRODUCT_IDENTITY.urls.website);
        expect(urls.docs).toBe(PRODUCT_IDENTITY.urls.docs);
        expect(urls.repository).toBe(PRODUCT_IDENTITY.urls.repository);
        expect(urls.issues).toBe(PRODUCT_IDENTITY.urls.issues);
        expect(urls.support).toBe(PRODUCT_IDENTITY.urls.support);
      });
    });

    describe('getLegal', () => {
      it('should return legal information', () => {
        const legal = service.getLegal();
        expect(legal.license).toBe(PRODUCT_IDENTITY.legal.license);
        expect(legal.copyright).toBe(PRODUCT_IDENTITY.legal.copyright);
        expect(legal.privacy).toBe(PRODUCT_IDENTITY.legal.privacy);
        expect(legal.terms).toBe(PRODUCT_IDENTITY.legal.terms);
      });
    });

    describe('getIdentity', () => {
      it('should return complete product identity', () => {
        const identity = service.getIdentity();
        expect(identity.displayName).toBe(PRODUCT_IDENTITY.displayName);
        expect(identity.version).toBe(PRODUCT_IDENTITY.version);
        expect(identity.branding).toBeDefined();
        expect(identity.urls).toBeDefined();
        expect(identity.legal).toBeDefined();
      });

      it('should return a copy, not reference', () => {
        const identity1 = service.getIdentity();
        const identity2 = service.getIdentity();
        expect(identity1).not.toBe(identity2);
        expect(identity1).toEqual(identity2);
      });
    });

    describe('formatForDisplay', () => {
      it('should return formatted identity string', () => {
        const formatted = service.formatForDisplay();
        expect(formatted).toContain(PRODUCT_IDENTITY.displayName);
        expect(formatted).toContain(PRODUCT_IDENTITY.version);
        expect(formatted).toContain(PRODUCT_IDENTITY.tagline);
        expect(formatted).toContain(PRODUCT_IDENTITY.executable);
        expect(formatted).toContain(PRODUCT_IDENTITY.urls.website);
      });

      it('should include all key information', () => {
        const formatted = service.formatForDisplay();
        expect(formatted).toContain('Executable');
        expect(formatted).toContain('Package Scope');
        expect(formatted).toContain('State Directory');
        expect(formatted).toContain('Config File');
        expect(formatted).toContain('Website');
        expect(formatted).toContain('Documentation');
        expect(formatted).toContain('Repository');
        expect(formatted).toContain('License');
      });
    });

    describe('exportAsJson', () => {
      it('should return valid JSON string', () => {
        const json = service.exportAsJson();
        expect(() => JSON.parse(json)).not.toThrow();
      });

      it('should include all identity information', () => {
        const json = service.exportAsJson();
        const parsed = JSON.parse(json);
        expect(parsed.displayName).toBe(PRODUCT_IDENTITY.displayName);
        expect(parsed.version).toBe(PRODUCT_IDENTITY.version);
        expect(parsed.branding).toBeDefined();
        expect(parsed.urls).toBeDefined();
        expect(parsed.legal).toBeDefined();
      });
    });

    describe('validate', () => {
      it('should return valid result for correct identity', () => {
        const result = service.validate();
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should detect missing displayName', () => {
        const svc = new IdentityService({
          productIdentity: { displayName: '' },
        });
        const result = svc.validate();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Missing displayName');
      });

      it('should detect missing version', () => {
        const svc = new IdentityService({
          productIdentity: { version: '' },
        });
        const result = svc.validate();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Missing version');
      });

      it('should detect invalid version format', () => {
        const svc = new IdentityService({
          productIdentity: { version: 'invalid' },
        });
        const result = svc.validate();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Invalid version format');
      });

      it('should detect non-HTTPS website URL', () => {
        const svc = new IdentityService({
          productIdentity: {
            urls: { ...PRODUCT_IDENTITY.urls, website: 'http://example.com' },
          },
        });
        const result = svc.validate();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Website URL must use HTTPS');
      });
    });
  });

  describe('Singleton Pattern', () => {
    describe('getIdentityService', () => {
      it('should return singleton instance', () => {
        const instance1 = getIdentityService();
        const instance2 = getIdentityService();
        expect(instance1).toBe(instance2);
      });

      it('should create new instance after reset', () => {
        const instance1 = getIdentityService();
        resetIdentityService();
        const instance2 = getIdentityService();
        expect(instance1).not.toBe(instance2);
      });
    });

    describe('resetIdentityService', () => {
      it('should reset singleton instance', () => {
        const instance1 = getIdentityService();
        resetIdentityService();
        const instance2 = getIdentityService();
        expect(instance1).not.toBe(instance2);
      });
    });
  });

  describe('Integration Tests', () => {
    it('should work with all methods in sequence', () => {
      const displayName = service.getDisplayName();
      const version = service.getVersion();
      const branding = service.getBranding();
      const urls = service.getUrls();
      const info = service.getProductInfo();

      expect(displayName).toBeDefined();
      expect(version).toBeDefined();
      expect(branding).toBeDefined();
      expect(urls).toBeDefined();
      expect(info).toBeDefined();
    });

    it('should handle custom configuration', () => {
      const svc = new IdentityService({
        productIdentity: {
          displayName: 'Test Product',
          version: '2.0.0',
          executable: 'test',
        },
      });

      expect(svc.getDisplayName()).toBe('Test Product');
      expect(svc.getVersion()).toBe('2.0.0');
      expect(svc.getExecutableName()).toBe('test');
    });

    it('should maintain immutability of returned objects', () => {
      const urls1 = service.getUrls();
      const urls2 = service.getUrls();
      expect(urls1).not.toBe(urls2);
      expect(urls1).toEqual(urls2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings in override', () => {
      const svc = new IdentityService({
        productIdentity: { displayName: '' },
      });
      expect(svc.getDisplayName()).toBe('');
    });

    it('should handle special characters in strings', () => {
      const svc = new IdentityService({
        productIdentity: { displayName: 'Test <>&"\' Product' },
      });
      expect(svc.getDisplayName()).toBe('Test <>&"\' Product');
    });

    it('should handle Unicode characters', () => {
      const svc = new IdentityService({
        productIdentity: { displayName: '产品测试 🦞' },
      });
      expect(svc.getDisplayName()).toBe('产品测试 🦞');
    });
  });
});
