import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { testing } from "./voice-call-gateway.js";

describe("Voice Call QA Gateway producer", () => {
  it("pins classic webhook responses to the session-aware mock provider", () => {
    const config = testing.withVoiceCallConfig({
      config: {} as OpenClawConfig,
      pluginDir: "/tmp/qa-voice-call-runtime",
      servePort: 12345,
    });

    expect(config.plugins?.entries?.["voice-call"]?.config).toMatchObject({
      provider: "mock",
      responseModel: "mock-openai/gpt-5.6-luna",
    });
  });
});
