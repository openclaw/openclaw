import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

/**
 * Regression tests for ModelProviderSchema — specifically the `models` field.
 *
 * Users who configure `models.providers.<id>` solely for credential/baseUrl
 * purposes (e.g. a custom OpenAI-compatible embedding endpoint) should be able
 * to omit the `models` array without triggering a validation error.  A failed
 * validation causes the gateway to keep running with the stale config and
 * silently fall back to the default provider baseUrl.
 *
 * See: https://github.com/openclaw/openclaw/issues/39589
 */
describe("ModelProviderSchema", () => {
  it("accepts a provider entry without a models array (defaults to [])", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.custom-provider.net/v1",
            apiKey: "sk-test",
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models?.providers?.["openai"]?.models).toEqual([]);
      expect(result.data.models?.providers?.["openai"]?.baseUrl).toBe(
        "https://api.custom-provider.net/v1",
      );
    }
  });

  it("accepts a provider entry with an explicit empty models array", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.custom-provider.net/v1",
            apiKey: "sk-test",
            models: [],
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models?.providers?.["openai"]?.models).toEqual([]);
    }
  });

  it("preserves baseUrl from models.providers when models field is omitted", () => {
    // Ensures the custom baseUrl survives config validation so the embedding
    // system can pick it up instead of falling back to the hardcoded default.
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.gptsapi.net/v1",
            api: "openai-completions",
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models?.providers?.["openai"]?.baseUrl).toBe("https://api.gptsapi.net/v1");
    }
  });
});
