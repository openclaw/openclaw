import { describe, it, expect } from "vitest";
import { validateConfigWithUnknownKeyRecovery } from "./validation.js";

describe("validateConfigWithUnknownKeyRecovery", () => {
  it("passes valid config through unchanged", () => {
    const raw = { tools: { sessions: { visibility: "all" } } };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strippedKeys).toEqual([]);
    }
  });

  it("strips unrecognized top-level keys and recovers config", () => {
    const raw = {
      tools: { sessions: { visibility: "all" } },
      bogusTopLevel: { foo: "bar" },
    };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strippedKeys).toContain("bogusTopLevel");
      // The valid config should still be present
      expect((result.config as Record<string, unknown>).tools).toBeDefined();
    }
  });

  it("strips unrecognized nested keys and recovers config", () => {
    const raw = {
      skills: {
        install: { preferBrew: true },
        "nano-banana-pro": { env: { GEMINI_API_KEY: "test" } },
      },
    };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strippedKeys).toContain("skills.nano-banana-pro");
      // Valid nested config preserved
      const skills = (result.config as Record<string, unknown>).skills as Record<string, unknown>;
      expect(skills?.install).toBeDefined();
    }
  });

  it("preserves all valid settings when stripping unknown keys", () => {
    const raw = {
      tools: { sessions: { visibility: "all" } },
      fakeThing: true,
    };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tools = (result.config as Record<string, unknown>).tools as Record<string, unknown>;
      const sessions = tools?.sessions as Record<string, unknown>;
      expect(sessions?.visibility).toBe("all");
    }
  });

  it("fails on structural errors (not just unknown keys)", () => {
    const raw = {
      tools: { sessions: { visibility: 12345 } }, // wrong type
    };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    expect(result.ok).toBe(false);
  });

  it("fails on mixed structural + unknown key errors", () => {
    const raw = {
      tools: { sessions: { visibility: 12345 } }, // wrong type
      bogus: true, // unknown key
    };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    // Should fail because there are structural errors, not just unknown keys
    expect(result.ok).toBe(false);
  });

  it("includes stripped key paths in warnings", () => {
    const raw = {
      skills: {
        "my-custom-skill": { env: { KEY: "val" } },
      },
    };
    const result = validateConfigWithUnknownKeyRecovery(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const warningMessages = result.warnings.map((w) => w.message);
      expect(warningMessages.some((m) => m.includes("skills.my-custom-skill"))).toBe(true);
    }
  });
});
