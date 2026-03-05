import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stripUnknownConfigKeys } from "./doctor-config-flow.js";

describe("stripUnknownConfigKeys", () => {
  it("should return empty removed array when config is valid", () => {
    const config = {
      gateway: {
        mode: "local" as const,
      },
    };

    const result = stripUnknownConfigKeys(config);

    expect(result.removed).toEqual([]);
    expect(result.config).toEqual(config);
  });

  it("should handle config with unknown keys without throwing", () => {
    const config = {
      gateway: {
        mode: "local" as const,
      },
      agents: {
        defaults: {
          pdfModel: "gpt-4-vision-preview", // Unknown key
        },
      },
    } as OpenClawConfig;

    // Should not throw
    expect(() => stripUnknownConfigKeys(config)).not.toThrow();

    const result = stripUnknownConfigKeys(config);
    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
    expect(Array.isArray(result.removed)).toBe(true);
  });

  it("should handle multiple unknown keys", () => {
    const config = {
      gateway: {
        mode: "local" as const,
        unknownKey: "value", // Unknown key
      },
      agents: {
        defaults: {
          anotherUnknown: "value", // Unknown key
        },
      },
    } as OpenClawConfig;

    const result = stripUnknownConfigKeys(config);

    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
    expect(Array.isArray(result.removed)).toBe(true);
  });

  it("should not throw errors for nested config", () => {
    const config = {
      gateway: {
        mode: "local" as const,
        auth: {
          mode: "token" as const,
          unknownNestedKey: "value", // Unknown nested key
        },
      },
    } as OpenClawConfig;

    expect(() => stripUnknownConfigKeys(config)).not.toThrow();
  });

  it("should preserve valid config structure", () => {
    const config = {
      gateway: {
        mode: "local" as const,
      },
    };

    const result = stripUnknownConfigKeys(config);

    expect(result.config.gateway?.mode).toBe("local");
  });
});
