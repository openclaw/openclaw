import { describe, expect, it } from "vitest";
import { detectModelConfigPath } from "./config-cli.js";

describe("detectModelConfigPath", () => {
  it("recognizes model config paths", () => {
    expect(detectModelConfigPath("agents.defaults.model")).toBe(true);
    expect(detectModelConfigPath("agents.defaults.model.primary")).toBe(true);
    expect(detectModelConfigPath("agents.list.0.model")).toBe(true);
    expect(detectModelConfigPath("agents.list.1.model")).toBe(true);
  });

  it("rejects non-model config paths", () => {
    expect(detectModelConfigPath("agents.defaults.model.fallbacks")).toBe(false);
    expect(detectModelConfigPath("agents.defaults.model.fallbacks.0")).toBe(false);
    expect(detectModelConfigPath("gateway.mode")).toBe(false);
    expect(detectModelConfigPath("channels.telegram.enabled")).toBe(false);
    expect(detectModelConfigPath("models.providers.0.apiKey")).toBe(false);
    expect(detectModelConfigPath("agents.defaults.heartbeat.target")).toBe(false);
  });
});
