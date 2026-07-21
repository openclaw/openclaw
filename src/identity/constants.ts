/**
 * Titanium Claws Identity Constants
 * 
 * Single source of truth for all product identity information.
 * These constants are immutable and define the core identity of Titanium Claws.
 */

import type {
  ProductIdentity,
  LegacyIdentity,
  ColorScheme,
  Typography,
  BrandingAssets,
  URLs,
  Legal,
} from './types.js';

/**
 * Complete product identity definition for Titanium Claws.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 * @readonly
 */
export const PRODUCT_IDENTITY: Readonly<ProductIdentity> = {
  // ─── Public Identity ────────────────────────────────────────────
  displayName: 'Titanium Claws',
  shortName: 'Titanium',
  tagline: 'Rust-Powered Multi-Agent Intelligence',
  description:
    'High-performance, multi-agent AI system with Rust-native engines for 10-100x performance improvements over traditional implementations',

  // ─── Technical Identity ─────────────────────────────────────────
  executable: 'tc',
  executableFull: 'titanium-claws',
  packageScope: '@titanium-claws',
  repository: 'titanium-claws/titanium-claws',

  // ─── Configuration ──────────────────────────────────────────────
  stateDirectory: '.titanium-claws',
  configFile: 'titanium-claws.json',
  databaseFile: 'titanium-claws.sqlite',
  logFile: 'titanium-claws.log',
  envPrefix: 'TITANIUM_CLAWS',

  // ─── Versioning ─────────────────────────────────────────────────
  version: '1.0.0',
  openclawCompatibility: '2026.7.2',
  protocolVersion: '1.0.0',

  // ─── Branding ───────────────────────────────────────────────────
  branding: {
    logo: {
      light: 'assets/logos/titanium-claws-light.svg',
      dark: 'assets/logos/titanium-claws-dark.svg',
      icon: 'assets/logos/titanium-claws-icon.svg',
    },
    colors: {
      primary: '#4A5568', // Titanium Gray
      secondary: '#2C5282', // Steel Blue
      accent: '#E53E3E', // Lobster Red
      success: '#38A169', // Performance Green
      warning: '#D69E2E', // Benchmark Yellow
      error: '#C53030', // Critical Red
      background: '#FFFFFF', // White
      text: '#1A202C', // Dark Gray
    },
    typography: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontFamilyMono: 'JetBrains Mono, monospace',
    },
  },

  // ─── Documentation ──────────────────────────────────────────────
  urls: {
    website: 'https://titaniumclaws.ai',
    docs: 'https://docs.titaniumclaws.ai',
    repository: 'https://github.com/titanium-claws/titanium-claws',
    issues: 'https://github.com/titanium-claws/titanium-claws/issues',
    support: 'mailto:support@titaniumclaws.ai',
  },

  // ─── Legal ──────────────────────────────────────────────────────
  legal: {
    license: 'MIT',
    copyright: '© 2026 Titanium Claws Contributors',
    privacy: 'https://titaniumclaws.ai/privacy',
    terms: 'https://titaniumclaws.ai/terms',
  },
} as const;

/**
 * Legacy OpenClaw identity for backward compatibility.
 * 
 * This constant will NEVER change and is used only for fallback resolution.
 * 
 * @stability Stable
 * @deprecated Use PRODUCT_IDENTITY for new code
 * @version 1.0.0
 * @since 1.0.0
 * @readonly
 */
export const LEGACY_IDENTITY: Readonly<LegacyIdentity> = {
  // ─── Public Identity ────────────────────────────────────────────
  displayName: 'OpenClaw',
  shortName: 'OpenClaw',
  tagline: 'Personal AI Assistant',
  description: 'Open-source AI agent framework',

  // ─── Technical Identity ─────────────────────────────────────────
  executable: 'openclaw',
  executableFull: 'openclaw',
  packageScope: '@openclaw',
  repository: 'openclaw/openclaw',

  // ─── Configuration ──────────────────────────────────────────────
  stateDirectory: '.openclaw',
  configFile: 'openclaw.json',
  databaseFile: 'openclaw.sqlite',
  logFile: 'openclaw.log',
  envPrefix: 'OPENCLAW',

  // ─── Versioning ─────────────────────────────────────────────────
  version: '2026.7.2',
  openclawCompatibility: '2026.7.2',
  protocolVersion: '1.0.0',

  // ─── Branding ───────────────────────────────────────────────────
  branding: {
    logo: {
      light: 'assets/logos/openclaw-light.svg',
      dark: 'assets/logos/openclaw-dark.svg',
      icon: 'assets/logos/openclaw-icon.svg',
    },
    colors: {
      primary: '#1A202C',
      secondary: '#2D3748',
      accent: '#E53E3E',
      success: '#38A169',
      warning: '#D69E2E',
      error: '#C53030',
      background: '#FFFFFF',
      text: '#1A202C',
    },
    typography: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontFamilyMono: 'JetBrains Mono, monospace',
    },
  },

  // ─── Documentation ──────────────────────────────────────────────
  urls: {
    website: 'https://openclaw.ai',
    docs: 'https://docs.openclaw.ai',
    repository: 'https://github.com/openclaw/openclaw',
    issues: 'https://github.com/openclaw/openclaw/issues',
    support: 'mailto:support@openclaw.ai',
  },

  // ─── Legal ──────────────────────────────────────────────────────
  legal: {
    license: 'MIT',
    copyright: '© 2026 OpenClaw Contributors',
    privacy: 'https://openclaw.ai/privacy',
    terms: 'https://openclaw.ai/terms',
  },
} as const;

/**
 * Default color scheme for Titanium Claws.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const DEFAULT_COLOR_SCHEME: Readonly<ColorScheme> = Object.freeze({
  primary: '#4A5568',
  secondary: '#2C5282',
  accent: '#E53E3E',
  success: '#38A169',
  warning: '#D69E2E',
  error: '#C53030',
  background: '#FFFFFF',
  text: '#1A202C',
});

/**
 * Default typography configuration for Titanium Claws.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const DEFAULT_TYPOGRAPHY: Readonly<Typography> = Object.freeze({
  fontFamily: 'Inter, system-ui, sans-serif',
  fontFamilyMono: 'JetBrains Mono, monospace',
});

/**
 * Environment variable mappings for Titanium Claws.
 * 
 * Maps generic environment variable names to their prefixed versions.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const ENVIRONMENT_VARIABLES = {
  STATE_DIR: 'TITANIUM_CLAWS_STATE_DIR',
  CONFIG_PATH: 'TITANIUM_CLAWS_CONFIG_PATH',
  GATEWAY_TOKEN: 'TITANIUM_CLAWS_GATEWAY_TOKEN',
  GATEWAY_PASSWORD: 'TITANIUM_CLAWS_GATEWAY_PASSWORD',
  LOG_LEVEL: 'TITANIUM_CLAWS_LOG_LEVEL',
  DATABASE_URL: 'TITANIUM_CLAWS_DATABASE_URL',
  REDIS_URL: 'TITANIUM_CLAWS_REDIS_URL',
} as const;

/**
 * Legacy environment variable mappings for backward compatibility.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const LEGACY_ENVIRONMENT_VARIABLES = {
  STATE_DIR: 'OPENCLAW_STATE_DIR',
  CONFIG_PATH: 'OPENCLAW_CONFIG_PATH',
  GATEWAY_TOKEN: 'OPENCLAW_GATEWAY_TOKEN',
  GATEWAY_PASSWORD: 'OPENCLAW_GATEWAY_PASSWORD',
  LOG_LEVEL: 'OPENCLAW_LOG_LEVEL',
  DATABASE_URL: 'OPENCLAW_DATABASE_URL',
  REDIS_URL: 'OPENCLAW_REDIS_URL',
} as const;

/**
 * Supported platforms for Titanium Claws.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const SUPPORTED_PLATFORMS = [
  'darwin-x64', // macOS Intel
  'darwin-arm64', // macOS Apple Silicon
  'linux-x64', // Linux x64
  'linux-arm64', // Linux ARM64
  'win32-x64', // Windows x64
] as const;

/**
 * Supported Node.js versions for Titanium Claws.
 * 
 * @stability Stable
 * @version 1.0.0
 * @since 1.0.0
 */
export const SUPPORTED_NODE_VERSIONS = {
  minimum: '22.0.0',
  recommended: '22.16.0',
  maximum: '23.0.0',
} as const;

/**
 * Feature flags for Titanium Claws.
 * 
 * @stability Experimental
 * @version 1.0.0
 * @since 1.0.0
 */
export const FEATURE_FLAGS = {
  RUST_ENGINES: true,
  MULTI_AGENT: true,
  A2A_PROTOCOL: true,
  CAUSAL_GRAPH: true,
  BACKWARD_COMPATIBILITY: true,
} as const;
