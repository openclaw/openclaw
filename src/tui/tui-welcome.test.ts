import { describe, expect, it } from "vitest";
import { buildWelcomeMessage } from "./tui-welcome.js";

describe("buildWelcomeMessage", () => {
  it("shows connected status when Ollama is healthy", () => {
    const msg = buildWelcomeMessage({
      model: "ollama/gemma3:4b",
      ollamaHealthy: true,
      ollamaVersion: "0.6.2",
      modelsCount: 3,
    });
    expect(msg).toContain("Ollama connected ✓");
    expect(msg).toContain("0.6.2");
    expect(msg).toContain("3 models loaded");
  });

  it("shows setup instructions when Ollama is unhealthy", () => {
    const msg = buildWelcomeMessage({
      model: "ollama/gemma3:4b",
      ollamaHealthy: false,
      modelsCount: 0,
    });
    expect(msg).toContain("⚠ Ollama not detected");
    expect(msg).toContain("ollama serve");
    expect(msg).not.toContain("Ollama connected");
  });

  it("displays the model name", () => {
    const msg = buildWelcomeMessage({
      model: "ollama/llama3:8b",
      ollamaHealthy: true,
      modelsCount: 1,
    });
    expect(msg).toContain("ollama/llama3:8b");
  });

  it("shows singular model count", () => {
    const msg = buildWelcomeMessage({
      model: "ollama/gemma3:4b",
      ollamaHealthy: true,
      modelsCount: 1,
    });
    expect(msg).toContain("1 model loaded");
    expect(msg).not.toContain("1 models");
  });
});
