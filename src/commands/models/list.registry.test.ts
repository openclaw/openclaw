import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { toModelRow } from "./list.registry.js";

describe("toModelRow", () => {
  it("handles model with undefined input without crashing", () => {
    const model = {
      id: "grok-4-1-fast-reasoning",
      name: "Grok 4.1 Fast",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 8192,
      // `input` intentionally omitted — simulates custom provider model without input field
    } as unknown as Model<Api>;

    const row = toModelRow({
      model,
      key: "xai/grok-4-1-fast-reasoning",
      tags: ["reasoning"],
    });

    expect(row.input).toBe("text");
    expect(row.name).toBe("Grok 4.1 Fast");
    expect(row.missing).toBe(false);
  });

  it("handles model with empty input array", () => {
    const model = {
      id: "custom-model",
      name: "Custom",
      provider: "local",
      baseUrl: "http://localhost:1234/v1",
      reasoning: false,
      contextWindow: 100_000,
      maxTokens: 4096,
      input: [],
    } as unknown as Model<Api>;

    const row = toModelRow({
      model,
      key: "local/custom-model",
      tags: [],
    });

    expect(row.input).toBe("text");
    expect(row.missing).toBe(false);
  });

  it("correctly joins multi-modality input", () => {
    const model = {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
      input: ["text", "image"],
    } as unknown as Model<Api>;

    const row = toModelRow({
      model,
      key: "anthropic/claude-opus-4-6",
      tags: ["reasoning"],
    });

    expect(row.input).toBe("text+image");
    expect(row.missing).toBe(false);
  });
});
