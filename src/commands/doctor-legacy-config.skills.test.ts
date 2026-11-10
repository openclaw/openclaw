// Load shared migration mocks before their production consumers.
// oxfmt-ignore
import { useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";

describe("legacy skill migration", () => {
  useDoctorLegacyConfigFixture();

  it("migrates nano-banana skill config to native image generation config", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
          },
        },
      },
    });

    expect(res.config.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "google/gemini-3-pro-image-preview",
    });
    expect(res.config.models?.providers?.google?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "GEMINI_API_KEY",
    });
    expect(res.config.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(res.config.models?.providers?.google?.models).toStrictEqual([]);
    expect(res.config.skills?.entries).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved skills.entries.nano-banana-pro → agents.defaults.mediaModels.image.primary (google/gemini-3-pro-image-preview).",
      "Moved skills.entries.nano-banana-pro.apiKey → models.providers.google.apiKey.",
      "Removed legacy skills.entries.nano-banana-pro.",
    ]);
  });

  it("prefers legacy nano-banana env.GEMINI_API_KEY over skill apiKey during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "ignored-skill-api-key",
            env: {
              GEMINI_API_KEY: "env-gemini-key",
            },
          },
        },
      },
    });

    expect(res.config.models?.providers?.google?.apiKey).toBe("env-gemini-key");
    expect(res.config.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(res.config.models?.providers?.google?.models).toStrictEqual([]);
    expect(res.changes).toContain(
      "Moved skills.entries.nano-banana-pro.env.GEMINI_API_KEY → models.providers.google.apiKey.",
    );
  });

  it("preserves explicit native config while removing legacy nano-banana skill config", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          mediaModels: {
            image: { primary: "fal/fal-ai/flux/dev" },
          },
        },
      },
      models: {
        providers: {
          google: {
            apiKey: "existing-google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "legacy-gemini-key",
          },
          peekaboo: { enabled: true },
        },
      },
    });

    expect(res.config.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "fal/fal-ai/flux/dev",
    });
    expect(res.config.models?.providers?.google?.apiKey).toBe("existing-google-key");
    expect(res.config.skills?.entries).toEqual({
      peekaboo: { enabled: true },
    });
    expect(res.changes).toEqual(["Removed legacy skills.entries.nano-banana-pro."]);
  });

  it.each([{ retained: [] }, { retained: ["peekaboo"] }])(
    "keeps skills.allowBundled restrictive after removing nano-banana ($retained)",
    ({ retained }) => {
      const res = normalizeCompatibilityConfigValues({
        skills: { allowBundled: [...retained, "nano-banana-pro"] },
      });

      expect(res.config.skills?.allowBundled).toEqual(retained);
      expect(res.changes).toEqual(["Removed nano-banana-pro from skills.allowBundled."]);
    },
  );
});
