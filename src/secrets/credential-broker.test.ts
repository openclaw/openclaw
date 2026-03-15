import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CredentialBroker } from "./credential-broker.js";

// Mock getSecret to avoid real keychain access
vi.mock("./index.js", () => ({
  getSecret: vi.fn(async (name: string) => {
    if (name === "test_token") {
      return "secret-value-123";
    }
    if (name === "api_key") {
      return "api-key-456";
    }
    throw new Error(`Secret not found: ${name}`);
  }),
}));

// Mock auditLog to avoid file writes
vi.mock("./audit.js", () => ({
  auditLog: vi.fn(),
}));

describe("CredentialBroker", () => {
  describe("isEnabled", () => {
    test("returns false when broker not configured", () => {
      const config: OpenClawConfig = {
        security: {
          credentials: {
            mode: "balanced",
            broker: {
              enabled: false,
            },
          },
        },
      };
      const broker = new CredentialBroker(config);
      expect(broker.isEnabled("any-tool")).toBe(false);
    });

    test("returns false when broker config missing", () => {
      const config: OpenClawConfig = {};
      const broker = new CredentialBroker(config);
      expect(broker.isEnabled("any-tool")).toBe(false);
    });

    test("returns true when enabled and tool in interceptTools", () => {
      const config: OpenClawConfig = {
        security: {
          credentials: {
            mode: "balanced",
            broker: {
              enabled: true,
              interceptTools: ["exec", "browser"],
            },
          },
        },
      };
      const broker = new CredentialBroker(config);
      expect(broker.isEnabled("exec")).toBe(true);
      expect(broker.isEnabled("browser")).toBe(true);
      expect(broker.isEnabled("read")).toBe(false);
    });

    test("returns true for all tools when interceptTools empty", () => {
      const config: OpenClawConfig = {
        security: {
          credentials: {
            mode: "balanced",
            broker: {
              enabled: true,
              interceptTools: [],
            },
          },
        },
      };
      const broker = new CredentialBroker(config);
      expect(broker.isEnabled("exec")).toBe(true);
      expect(broker.isEnabled("browser")).toBe(true);
      expect(broker.isEnabled("read")).toBe(true);
    });

    test("returns true for all tools when interceptTools undefined", () => {
      const config: OpenClawConfig = {
        security: {
          credentials: {
            mode: "balanced",
            broker: {
              enabled: true,
            },
          },
        },
      };
      const broker = new CredentialBroker(config);
      expect(broker.isEnabled("any-tool")).toBe(true);
    });
  });

  describe("resolve", () => {
    const config: OpenClawConfig = {
      security: {
        credentials: {
          mode: "balanced",
          broker: { enabled: true },
        },
      },
    };

    test("throws on invalid ref (no 'secret:' prefix)", async () => {
      const broker = new CredentialBroker(config);
      await expect(broker.resolve("test_token")).rejects.toThrow(
        'Invalid credential reference: test_token (must start with "secret:")',
      );
    });

    test("throws on invalid ref (only 'secret:')", async () => {
      const broker = new CredentialBroker(config);
      await expect(broker.resolve("secret:")).rejects.toThrow(
        "Invalid credential reference: secret: (empty secret name)",
      );
    });

    test("resolves valid ref", async () => {
      const broker = new CredentialBroker(config);
      const result = await broker.resolve("secret:test_token");
      expect(result).toEqual({
        ref: "secret:test_token",
        value: "secret-value-123",
        name: "test_token",
      });
    });

    test("throws when secret not found", async () => {
      const broker = new CredentialBroker(config);
      await expect(broker.resolve("secret:nonexistent")).rejects.toThrow(
        "Secret not found: nonexistent",
      );
    });
  });

  describe("inject", () => {
    const config: OpenClawConfig = {
      security: {
        credentials: {
          mode: "balanced",
          broker: {
            enabled: true,
            interceptTools: ["exec", "browser"],
          },
        },
      },
    };

    test("passes through when broker disabled for tool", async () => {
      const broker = new CredentialBroker(config);
      const params = { command: "echo test", credentialRef: "secret:test_token" };
      const result = await broker.inject("read", params);
      expect(result).toBe(params); // Same reference when disabled
    });

    test("deep clones params (original unchanged)", async () => {
      const broker = new CredentialBroker(config);
      const original = { command: "echo test", auth: { credentialRef: "secret:test_token" } };
      const result = await broker.inject("exec", original);

      // Original unchanged
      expect(original).toEqual({
        command: "echo test",
        auth: { credentialRef: "secret:test_token" },
      });

      // Result is different reference
      expect(result).not.toBe(original);
      expect(result.auth).not.toBe(original.auth);

      // Result has credential injected
      expect(result).toEqual({
        command: "echo test",
        auth: { value: "secret-value-123" },
      });
    });

    test("replaces credentialRef with value in top-level object", async () => {
      const broker = new CredentialBroker(config);
      const params = { credentialRef: "secret:api_key" };
      const result = await broker.inject("exec", params);

      expect(result).toEqual({ value: "api-key-456" });
      expect(result).not.toHaveProperty("credentialRef");
    });

    test("replaces credentialRef in nested objects", async () => {
      const broker = new CredentialBroker(config);
      const params = {
        command: "curl",
        headers: {
          Authorization: { credentialRef: "secret:api_key" },
        },
      };
      const result = await broker.inject("exec", params);

      expect(result).toEqual({
        command: "curl",
        headers: {
          Authorization: { value: "api-key-456" },
        },
      });
    });

    test("handles arrays with credentialRef items", async () => {
      const broker = new CredentialBroker(config);
      const params = {
        requests: [
          { url: "https://api.example.com", auth: { credentialRef: "secret:api_key" } },
          { url: "https://other.example.com", auth: { credentialRef: "secret:test_token" } },
        ],
      };
      const result = await broker.inject("browser", params);

      expect(result).toEqual({
        requests: [
          { url: "https://api.example.com", auth: { value: "api-key-456" } },
          { url: "https://other.example.com", auth: { value: "secret-value-123" } },
        ],
      });
    });

    test("handles deeply nested structures", async () => {
      const broker = new CredentialBroker(config);
      const params = {
        level1: {
          level2: {
            level3: {
              credentialRef: "secret:test_token",
            },
          },
        },
      };
      const result = await broker.inject("exec", params);

      expect(result).toEqual({
        level1: {
          level2: {
            level3: {
              value: "secret-value-123",
            },
          },
        },
      });
    });

    test("preserves non-credentialRef fields", async () => {
      const broker = new CredentialBroker(config);
      const params = {
        command: "curl",
        timeout: 5000,
        auth: {
          credentialRef: "secret:api_key",
          type: "bearer",
        },
      };
      const result = await broker.inject("exec", params);

      expect(result).toEqual({
        command: "curl",
        timeout: 5000,
        auth: {
          value: "api-key-456",
          type: "bearer",
        },
      });
    });
  });
});
