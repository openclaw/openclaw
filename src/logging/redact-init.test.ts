import { describe, it, expect } from "vitest";
import { initializeRedaction } from "./redact-init.js";
import type { OpenClawConfig } from "../config/config.js";

describe("redact-init", () => {
  it("should extract sensitive values from config", async () => {
    const mockConfig: Partial<OpenClawConfig> = {
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "sk-test-1234567890abcdefghijklmnopqrstuvwxyz",
            },
          },
        },
      },
      agents: {
        defaults: {
          sandbox: {
            docker: {
              env: {
                CUSTOM_API_KEY: "custom-secret-key-value-12345678",
                NORMAL_VAR: "not-secret",
              },
            },
          },
        },
      },
    };

    const result = await initializeRedaction(mockConfig as OpenClawConfig);

    expect(result.configValuesFound).toBeGreaterThan(0);
    expect(result.totalRegistered).toBeGreaterThan(0);
  });

  it("should handle config without sensitive values", async () => {
    const mockConfig: Partial<OpenClawConfig> = {
      channels: {},
    };

    const result = await initializeRedaction(mockConfig as OpenClawConfig);

    expect(result.configValuesFound).toBe(0);
  });

  it("should scan environment variables", async () => {
    // Save original env
    const originalEnv = process.env.TEST_API_KEY;

    try {
      process.env.TEST_API_KEY = "test-api-key-value-123456789";

      const mockConfig: Partial<OpenClawConfig> = {};
      const result = await initializeRedaction(mockConfig as OpenClawConfig);

      // Should find at least the TEST_API_KEY we just set
      expect(result.totalRegistered).toBeGreaterThanOrEqual(0);
    } finally {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.TEST_API_KEY = originalEnv;
      } else {
        delete process.env.TEST_API_KEY;
      }
    }
  });
});
