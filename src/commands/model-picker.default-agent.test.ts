// Model picker tests read the configured target agent without rewriting global defaults.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing } from "../flows/model-picker.js";

describe("model picker default-agent ownership", () => {
  it("projects the resolved agent override into picker defaults", () => {
    const config = {
      agents: {
        defaults: {
          model: "openai/global-model",
          models: { "openai/global-model": {} },
        },
        entries: {
          ops: {
            default: true,
            model: "anthropic/ops-model",
            models: { "anthropic/ops-model": {} },
          },
        },
      },
    } satisfies OpenClawConfig;

    const pickerConfig = testing.resolveModelPickerConfig(config, "ops");

    expect(pickerConfig.agents?.defaults?.model).toBe("anthropic/ops-model");
    expect(pickerConfig.agents?.defaults?.models).toEqual({
      "openai/global-model": {},
      "anthropic/ops-model": {},
    });
    expect(config.agents.defaults.model).toBe("openai/global-model");
  });
});
