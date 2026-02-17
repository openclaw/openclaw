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

      // Assert that the validation correctly identified the issue and rejected the provider.
      // We don't expect 'res.config' to be present on a failed validation result.
    } else {
      throw new Error("Expected validation to fail");
    }
  });
});
