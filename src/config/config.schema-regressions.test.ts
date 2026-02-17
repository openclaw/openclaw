import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("gracefully disables providers with invalid `api` types", () => {
    const invalidGoogleApiConfig = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "AIzaSyAdowY0C9oOYmkzWlgdE4SJVYSt6aRITbE",
            api: "invalid-google-api-type", // This is the invalid input
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
              },
            ],
          },
          anthropic: {
            // A valid provider to ensure others still work
            baseUrl: "https://api.anthropic.com/v1",
            apiKey: "sk-ant-valid",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-3-opus-20240229",
                name: "Claude 3 Opus",
              },
            ],
          },
        },
      },
    };

    const res = validateConfigObject(invalidGoogleApiConfig);

    // Expect validation to fail for the specific provider, but not crash
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "models.providers.google.api",
          message: "Invalid input", // Updated to match actual Zod error message
        }),
      ]),
    );

    // Crucially, assert that the invalid provider is *not* present in the returned config
    // This demonstrates graceful degradation.
    expect(res.config.models?.providers).not.toHaveProperty("google");
    // And valid providers should still be present
    expect(res.config.models?.providers).toHaveProperty("anthropic");
  });
});
