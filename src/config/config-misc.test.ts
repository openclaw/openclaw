import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("$schema key in config (#14998)", () => {
  it("accepts config with $schema string", () => {
    const result = OpenClawSchema.safeParse({
      $schema: "https://openclaw.ai/config.json",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.$schema).toBe("https://openclaw.ai/config.json");
    }
  });

  it("accepts config without $schema", () => {
    const result = OpenClawSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects non-string $schema", () => {
    const result = OpenClawSchema.safeParse({ $schema: 123 });
    expect(result.success).toBe(false);
  });
});

describe("ui.seamColor", () => {
  it("accepts hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500" } });
    expect(res.ok).toBe(true);
  });

  it("rejects non-hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "lobster" } });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid hex length", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500FF" } });
    expect(res.ok).toBe(false);
  });
});

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-key",
              baseUrl: "https://api.perplexity.ai",
              model: "perplexity/sonar-pro",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});

describe("talk.voiceAliases", () => {
  it("accepts a string map of voice aliases", () => {
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: "EXAVITQu4vr4xnSDxMaL",
          Roger: "CwhRBWXzGAHq8TQ4Fs17",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-string voice alias values", () => {
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});
