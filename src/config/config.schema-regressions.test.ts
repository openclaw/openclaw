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

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Type guard for error case
      expect(res.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "models.providers.google.api",
            message: "Invalid input",
          }),
        ]),
      );

      // Assert that the config returned when ok is false does NOT contain the invalid provider
      // The overall `res.config` might be null/undefined, or a partial object depending on how
      // `validateConfigObject` is implemented to recover.
      // For this test, we expect the invalid provider to be filtered out if `models.providers` exists.
      // If `res.config` is present and has models.providers, then it should *not* have 'google'.
      if (res.config?.models?.providers) {
        expect(res.config.models.providers).not.toHaveProperty("google");
        expect(res.config.models.providers).toHaveProperty("anthropic");
      } else {
        // If models.providers is completely absent, that's also valid graceful degradation.
        expect(res.config?.models?.providers).toBeUndefined();
      }
    } else {
      throw new Error("Expected validation to fail");
    }
  });
});
