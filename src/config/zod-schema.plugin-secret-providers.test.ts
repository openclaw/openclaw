import { describe, expect, it } from "vitest";
import {
  SecretInputSchema,
  SecretProviderSchema,
  SecretRefSchema,
  SecretsConfigSchema,
} from "./zod-schema.core.js";

describe("zod schemas accept plugin-owned secret sources", () => {
  describe("SecretProviderSchema", () => {
    it("accepts a config for a plugin-owned source with extra fields", () => {
      const r = SecretProviderSchema.safeParse({
        source: "gcp",
        project: "test-proj",
        versionSuffix: "latest",
      });
      expect(r.success).toBe(true);
    });

    it("still accepts the three built-in sources", () => {
      expect(SecretProviderSchema.safeParse({ source: "env" }).success).toBe(true);
      expect(
        SecretProviderSchema.safeParse({
          source: "file",
          path: "/abs/path/secrets.json",
        }).success,
      ).toBe(true);
      expect(
        SecretProviderSchema.safeParse({
          source: "exec",
          command: "/usr/local/bin/resolver",
        }).success,
      ).toBe(true);
    });

    it("still rejects empty/missing source", () => {
      expect(SecretProviderSchema.safeParse({ source: "" }).success).toBe(false);
      expect(SecretProviderSchema.safeParse({}).success).toBe(false);
    });

    it("rejects a config that uses a built-in source name with extra fields", () => {
      // This used to be caught by .strict() on the discriminated arms.
      // After C1, the plugin fall-through arm must NOT swallow these.
      const r = SecretProviderSchema.safeParse({
        source: "env",
        unknownField: "x",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("SecretRefSchema", () => {
    it("accepts a SecretRef for a plugin-owned source", () => {
      const r = SecretRefSchema.safeParse({
        source: "gcp",
        provider: "my-gcp",
        id: "OPENAI_KEY",
      });
      expect(r.success).toBe(true);
    });

    it("accepts SecretInput as a plugin-owned ref", () => {
      const r = SecretInputSchema.safeParse({
        source: "keyring",
        provider: "default",
        id: "slack-bot",
      });
      expect(r.success).toBe(true);
    });

    it("still accepts the three built-in ref sources", () => {
      expect(
        SecretRefSchema.safeParse({
          source: "env",
          provider: "default",
          id: "OPENAI_KEY",
        }).success,
      ).toBe(true);
    });

    it("rejects refs missing required fields", () => {
      expect(SecretRefSchema.safeParse({ source: "gcp" }).success).toBe(false);
      expect(SecretRefSchema.safeParse({ source: "gcp", provider: "" }).success).toBe(false);
      expect(SecretRefSchema.safeParse({ source: "gcp", provider: "p", id: "" }).success).toBe(
        false,
      );
    });

    it("rejects an env ref whose id violates the env name pattern", () => {
      const r = SecretRefSchema.safeParse({
        source: "env",
        provider: "default",
        id: "lower-case-not-allowed",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("SecretsConfigSchema", () => {
    it("accepts a providers map with a mix of built-in and plugin-owned sources", () => {
      const r = SecretsConfigSchema.safeParse({
        providers: {
          default: { source: "env" },
          "my-gcp": { source: "gcp", project: "test-proj" },
          local: { source: "keyring", service: "openclaw" },
        },
      });
      expect(r.success).toBe(true);
    });
  });
});
