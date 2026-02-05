import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  getCliTimeoutMs,
  getToolTimeoutMs,
  getGatewayTimeoutMs,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_GATEWAY_TIMEOUT_MS,
} from '../timeout-config.js';

describe('Timeout Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('CLI Timeout', () => {
    test('returns default CLI timeout by default', () => {
      delete process.env.OPENCLAW_CLI_TIMEOUT_MS;
      expect(getCliTimeoutMs()).toBe(DEFAULT_CLI_TIMEOUT_MS);
    });

    test('respects OPENCLAW_CLI_TIMEOUT_MS env var', () => {
      process.env.OPENCLAW_CLI_TIMEOUT_MS = '30000';
      expect(getCliTimeoutMs()).toBe(30_000);
    });

    test('ignores invalid CLI timeout values', () => {
      process.env.OPENCLAW_CLI_TIMEOUT_MS = 'invalid';
      expect(getCliTimeoutMs()).toBe(DEFAULT_CLI_TIMEOUT_MS);
    });

    test('ignores negative CLI timeout values', () => {
      process.env.OPENCLAW_CLI_TIMEOUT_MS = '-5000';
      expect(getCliTimeoutMs()).toBe(DEFAULT_CLI_TIMEOUT_MS);
    });

    test('ignores zero CLI timeout values', () => {
      process.env.OPENCLAW_CLI_TIMEOUT_MS = '0';
      expect(getCliTimeoutMs()).toBe(DEFAULT_CLI_TIMEOUT_MS);
    });
  });

  describe('Tool Timeout', () => {
    test('returns default tool timeout by default', () => {
      delete process.env.OPENCLAW_TOOL_TIMEOUT_MS;
      expect(getToolTimeoutMs()).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    });

    test('respects global OPENCLAW_TOOL_TIMEOUT_MS env var', () => {
      process.env.OPENCLAW_TOOL_TIMEOUT_MS = '20000';
      expect(getToolTimeoutMs()).toBe(20_000);
    });

    test('respects tool-specific env var', () => {
      process.env.OPENCLAW_TOOL_NODES_TIMEOUT_MS = '45000';
      expect(getToolTimeoutMs('nodes')).toBe(45_000);
    });

    test('tool-specific env var overrides global', () => {
      process.env.OPENCLAW_TOOL_TIMEOUT_MS = '20000';
      process.env.OPENCLAW_TOOL_SESSIONS_SEND_TIMEOUT_MS = '60000';
      expect(getToolTimeoutMs('sessions-send')).toBe(60_000);
    });

    test('ignores invalid tool timeout values', () => {
      process.env.OPENCLAW_TOOL_TIMEOUT_MS = 'invalid';
      expect(getToolTimeoutMs()).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    });
  });

  describe('Gateway Timeout', () => {
    test('returns default gateway timeout by default', () => {
      delete process.env.OPENCLAW_GATEWAY_TIMEOUT_MS;
      expect(getGatewayTimeoutMs()).toBe(DEFAULT_GATEWAY_TIMEOUT_MS);
    });

    test('respects OPENCLAW_GATEWAY_TIMEOUT_MS env var', () => {
      process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = '120000';
      expect(getGatewayTimeoutMs()).toBe(120_000);
    });

    test('ignores invalid gateway timeout values', () => {
      process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = 'invalid';
      expect(getGatewayTimeoutMs()).toBe(DEFAULT_GATEWAY_TIMEOUT_MS);
    });
  });

  describe('Timeout Precedence', () => {
    test('tool-specific overrides global tool timeout', () => {
      process.env.OPENCLAW_TOOL_TIMEOUT_MS = '15000';
      process.env.OPENCLAW_TOOL_CUSTOM_TIMEOUT_MS = '50000';
      expect(getToolTimeoutMs('custom')).toBe(50_000);
      expect(getToolTimeoutMs('other')).toBe(15_000);
    });

    test('each component has independent configuration', () => {
      process.env.OPENCLAW_CLI_TIMEOUT_MS = '25000';
      process.env.OPENCLAW_TOOL_TIMEOUT_MS = '20000';
      process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = '120000';
      expect(getCliTimeoutMs()).toBe(25_000);
      expect(getToolTimeoutMs()).toBe(20_000);
      expect(getGatewayTimeoutMs()).toBe(120_000);
    });
  });
});
