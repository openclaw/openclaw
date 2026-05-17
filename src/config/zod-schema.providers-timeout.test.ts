import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema provider entries (#83201)", () => {
  it("accepts a built-in provider entry that only sets timeoutSeconds", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        openai: { timeoutSeconds: 60 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers?.openai?.timeoutSeconds).toBe(60);
      // baseUrl and models are no longer required at the schema level so
      // built-in providers can be overridden with just a request-timeout knob.
      expect(result.data.providers?.openai?.baseUrl).toBeUndefined();
      expect(result.data.providers?.openai?.models).toBeUndefined();
    }
  });

  it("still accepts a full custom provider entry (baseUrl + models)", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "custom-llm": {
          baseUrl: "https://example.com/v1",
          models: [{ id: "custom-1" }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unrecognized top-level keys (strict() still applies)", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        openai: { timeoutSeconds: 60, unknownKey: 1 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("still rejects negative timeoutSeconds", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        openai: { timeoutSeconds: -1 },
      },
    });
    expect(result.success).toBe(false);
  });
});
