import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginApi } from "./api-builder.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { PluginLogger } from "./types.js";

describe("buildPluginApi config isolation", () => {
  it("clones and freezes plugin config snapshots", () => {
    const sourceConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          heartbeat: { model: "minimax", every: "5m" },
        },
      },
    } as OpenClawConfig;

    const api = buildPluginApi({
      id: "test-plugin",
      name: "Test Plugin",
      source: "unit-test",
      registrationMode: "full",
      config: sourceConfig,
      runtime: {} as unknown as PluginRuntime,
      logger: {} as unknown as PluginLogger,
      resolvePath: (input) => input,
    });

    // Mutate the original object after API creation
    (sourceConfig as Record<string, unknown>).agents = {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        heartbeat: { model: "changed", every: "5m" },
      },
    };

    // API config should be isolated from mutations
    expect(api.config.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(api.config.agents?.defaults?.heartbeat).toEqual({
      model: "minimax",
      every: "5m",
    });

    // API config should be frozen
    expect(() => {
      (api.config.agents!.defaults!.model as { primary: string }).primary = "mutated";
    }).toThrow(TypeError);
  });
});
