import { describe, expect, it } from "vitest";
import {
  DEPRECATED_PROVIDER_MAP,
  detectDeprecatedProviders,
  migrateProviderRefs,
} from "./doctor-provider-migration.js";

describe("doctor-provider-migration", () => {
  describe("DEPRECATED_PROVIDER_MAP", () => {
    it("contains google-antigravity → google-gemini-cli mapping", () => {
      expect(DEPRECATED_PROVIDER_MAP["google-antigravity"]).toBe("google-gemini-cli");
    });

    it("all values are non-empty strings", () => {
      for (const [key, value] of Object.entries(DEPRECATED_PROVIDER_MAP)) {
        expect(key.length).toBeGreaterThan(0);
        expect(value.length).toBeGreaterThan(0);
        expect(key).not.toBe(value);
      }
    });
  });

  describe("detectDeprecatedProviders", () => {
    it("returns empty map for config with no deprecated providers", () => {
      const cfg = {
        agents: { main: { model: "anthropic/claude-opus-4-6" } },
      };
      const result = detectDeprecatedProviders(cfg);
      expect(result.size).toBe(0);
    });

    it("detects google-antigravity references in model strings", () => {
      const cfg = {
        agents: {
          main: {
            model: "google-antigravity/gemini-3.1-pro-preview",
            failover: {
              primary: "google-antigravity/claude-opus-4-6-thinking",
              fallbacks: [
                "google-antigravity/claude-sonnet-4-5",
                "google-antigravity/gemini-3.1-pro-preview",
              ],
            },
          },
        },
        heartbeat: { model: "google-antigravity/gemini-3-flash" },
      };
      const result = detectDeprecatedProviders(cfg);
      expect(result.size).toBe(1);
      expect(result.has("google-antigravity")).toBe(true);
      expect(result.get("google-antigravity")).toBeGreaterThan(0);
    });

    it("does not false-positive on google-gemini-cli references", () => {
      const cfg = {
        agents: { main: { model: "google-gemini-cli/gemini-3-pro-preview" } },
      };
      const result = detectDeprecatedProviders(cfg);
      expect(result.size).toBe(0);
    });

    it("detects references in auth profile keys", () => {
      const cfg = {
        auth: {
          profiles: {
            "google-antigravity:google@wp-studio.dev": {
              provider: "google-antigravity",
              method: "oauth",
            },
          },
        },
      };
      const result = detectDeprecatedProviders(cfg);
      expect(result.size).toBe(1);
    });
  });

  describe("migrateProviderRefs", () => {
    it("migrates string values with provider prefix", () => {
      const obj: Record<string, unknown> = {
        model: "google-antigravity/gemini-3.1-pro-preview",
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(1);
      expect(obj.model).toBe("google-gemini-cli/gemini-3.1-pro-preview");
      expect(changes).toHaveLength(1);
    });

    it("migrates bare provider name in string values", () => {
      const obj: Record<string, unknown> = { provider: "google-antigravity" };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(1);
      expect(obj.provider).toBe("google-gemini-cli");
    });

    it("migrates object keys with provider prefix", () => {
      const obj: Record<string, unknown> = {
        "google-antigravity/gemini-3.1-pro-preview": { alias: "gemini3pro" },
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(1);
      expect(obj["google-gemini-cli/gemini-3.1-pro-preview"]).toBeDefined();
      expect(obj["google-antigravity/gemini-3.1-pro-preview"]).toBeUndefined();
    });

    it("migrates auth profile keys (provider:account format)", () => {
      const obj: Record<string, unknown> = {
        "google-antigravity:google@wp-studio.dev": {
          provider: "google-antigravity",
          method: "oauth",
        },
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBeGreaterThanOrEqual(2);
      expect(obj["google-gemini-cli:google@wp-studio.dev"]).toBeDefined();
      const profile = obj["google-gemini-cli:google@wp-studio.dev"] as Record<string, unknown>;
      expect(profile.provider).toBe("google-gemini-cli");
    });

    it("migrates array items with provider/model format", () => {
      const obj: Record<string, unknown> = {
        fallbacks: [
          "google-antigravity/claude-sonnet-4-5",
          "anthropic/claude-opus-4-6",
          "google-antigravity/gemini-3.1-pro-preview",
        ],
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(2);
      const fallbacks = obj.fallbacks as string[];
      expect(fallbacks[0]).toBe("google-gemini-cli/claude-sonnet-4-5");
      expect(fallbacks[1]).toBe("anthropic/claude-opus-4-6");
      expect(fallbacks[2]).toBe("google-gemini-cli/gemini-3.1-pro-preview");
    });

    it("migrates bare provider names in arrays", () => {
      const obj: Record<string, unknown> = {
        providers: ["google-antigravity", "anthropic", "kimi-coding"],
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(1);
      const providers = obj.providers as string[];
      expect(providers[0]).toBe("google-gemini-cli");
      expect(providers[1]).toBe("anthropic");
      expect(providers[2]).toBe("kimi-coding");
    });

    it("migrates provider:account format in arrays", () => {
      const obj: Record<string, unknown> = {
        profiles: ["google-antigravity:google@wp-studio.dev", "anthropic:openclaw"],
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(1);
      const profiles = obj.profiles as string[];
      expect(profiles[0]).toBe("google-gemini-cli:google@wp-studio.dev");
      expect(profiles[1]).toBe("anthropic:openclaw");
    });

    it("migrates deeply nested structures", () => {
      const obj = {
        agents: {
          main: {
            failover: {
              primary: "google-antigravity/claude-opus-4-6-thinking",
              fallbacks: ["google-antigravity/claude-sonnet-4-5"],
            },
            crons: [{ name: "morning", model: "google-antigravity/gemini-3-flash" }],
          },
        },
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(3);
      expect(obj.agents.main.failover.primary).toBe("google-gemini-cli/claude-opus-4-6-thinking");
      expect(obj.agents.main.failover.fallbacks[0]).toBe("google-gemini-cli/claude-sonnet-4-5");
      expect(obj.agents.main.crons[0].model).toBe("google-gemini-cli/gemini-3-flash");
    });

    it("does not touch unrelated providers", () => {
      const obj: Record<string, unknown> = {
        model: "anthropic/claude-opus-4-6",
        fallback: "kimi-coding/k2p5",
      };
      const changes: string[] = [];
      const count = migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(count).toBe(0);
      expect(obj.model).toBe("anthropic/claude-opus-4-6");
      expect(obj.fallback).toBe("kimi-coding/k2p5");
    });

    it("handles null and undefined gracefully", () => {
      const changes: string[] = [];
      expect(migrateProviderRefs(null, "a", "b", changes)).toBe(0);
      expect(migrateProviderRefs(undefined, "a", "b", changes)).toBe(0);
    });

    it("handles empty objects and arrays", () => {
      const changes: string[] = [];
      expect(migrateProviderRefs({}, "a", "b", changes)).toBe(0);
      expect(migrateProviderRefs([], "a", "b", changes)).toBe(0);
    });

    it("records accurate change paths", () => {
      const obj = {
        agents: { main: { model: "google-antigravity/gemini-3.1-pro-preview" } },
      };
      const changes: string[] = [];
      migrateProviderRefs(obj, "google-antigravity", "google-gemini-cli", changes);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain("agents.main.model");
      expect(changes[0]).toContain("google-antigravity/gemini-3.1-pro-preview");
      expect(changes[0]).toContain("google-gemini-cli/gemini-3.1-pro-preview");
    });

    it("simulates real-world config migration", () => {
      const cfg: Record<string, unknown> = {
        auth: {
          profiles: {
            "google-antigravity:google@wp-studio.dev": {
              provider: "google-antigravity",
              method: "oauth",
            },
          },
        },
        agents: {
          main: {
            failover: {
              primary: "google-antigravity/claude-opus-4-6-thinking",
              fallbacks: [
                "google-antigravity/claude-sonnet-4-5",
                "google-antigravity/gemini-3.1-pro-preview",
              ],
            },
          },
        },
        heartbeat: { model: "google-antigravity/gemini-3-flash" },
        crons: [
          {
            model: "google-antigravity/gemini-3-flash",
            failover: {
              primary: "google-antigravity/gemini-3.1-pro-preview",
              fallbacks: ["google-antigravity/claude-sonnet-4-5"],
            },
          },
        ],
        models: {
          overrides: {
            "google-antigravity/gemini-3.1-pro-preview": { alias: "gemini3pro" },
            "google-antigravity/claude-sonnet-4-5": { alias: "Sonnet 4.5 (AG)" },
          },
        },
      };

      const changes: string[] = [];
      const count = migrateProviderRefs(cfg, "google-antigravity", "google-gemini-cli", changes);

      // Verify no antigravity references remain
      const serialized = JSON.stringify(cfg);
      expect(serialized).not.toContain("google-antigravity");

      // Verify key replacements
      const auth = cfg.auth as Record<string, Record<string, unknown>>;
      expect(auth.profiles["google-gemini-cli:google@wp-studio.dev"]).toBeDefined();

      const models = cfg.models as Record<string, Record<string, unknown>>;
      expect(models.overrides["google-gemini-cli/gemini-3.1-pro-preview"]).toBeDefined();

      // Should have migrated all references
      expect(count).toBeGreaterThanOrEqual(10);
      expect(changes.length).toBe(count);
    });
  });
});
