import { describe, expect, it } from "vitest";
import { toModelRow } from "./list.registry.js";

describe("toModelRow: model.input undefined guard", () => {
  it("does not crash when model.input is undefined", () => {
    const model = {
      id: "custom-model",
      name: "Custom Model",
      provider: "custom-provider",
      api: "openai-completions" as const,
      contextWindow: 8192,
      maxTokens: 4096,
      // input deliberately omitted to simulate custom provider models
      // that don't define the input field
    } as unknown as Parameters<typeof toModelRow>[0]["model"];

    const row = toModelRow({
      model,
      key: "custom-provider/custom-model",
      tags: [],
    });

    expect(row.key).toBe("custom-provider/custom-model");
    expect(row.input).toBe("text");
    expect(row.missing).toBeFalsy();
  });

  it("correctly joins model.input when defined", () => {
    const model = {
      id: "vision-model",
      name: "Vision Model",
      provider: "openai",
      api: "openai-completions" as const,
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ["text", "image"],
    } as unknown as Parameters<typeof toModelRow>[0]["model"];

    const row = toModelRow({
      model,
      key: "openai/vision-model",
      tags: [],
    });

    expect(row.input).toBe("text+image");
  });

  it("returns '-' for missing model", () => {
    const row = toModelRow({
      model: undefined,
      key: "unknown/model",
      tags: ["custom"],
    });

    expect(row.input).toBe("-");
    expect(row.missing).toBe(true);
  });
});
