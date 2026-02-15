import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("model compat config schema", () => {
  it("accepts full openai-completions compat fields", () => {
    const res = validateConfigObject({
      models: {
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:1234/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen3-32b",
                name: "Qwen3 32B",
                compat: {
                  supportsUsageInStreaming: true,
                  supportsStrictMode: false,
                  thinkingFormat: "qwen",
                  requiresToolResultName: true,
                  requiresAssistantAfterToolResult: false,
                  requiresThinkingAsText: false,
                  requiresMistralToolIds: false,
                },
              },
            ],
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
