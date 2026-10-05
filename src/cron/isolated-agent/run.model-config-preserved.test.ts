import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveExtraParams } from "../../agents/embedded-agent-runner/extra-params.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronAgentConfig } from "./run-config.js";

function buildCronConfig(config: OpenClawConfig): OpenClawConfig {
  return resolveCronAgentConfig({
    config,
    agentConfigOverride: resolveAgentConfig(config, "worker"),
  }).cfgWithAgentDefaults;
}

describe("resolveCronAgentConfig model configuration preservation", () => {
  it("inherits model runtime policy while preserving explicit per-agent runtime overrides", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "example/primary": { agentRuntime: { id: "inherited-harness" } },
            "example/fallback": { agentRuntime: { id: "inherited-harness" } },
          },
        },
        list: [
          {
            id: "worker",
            models: {
              "example/primary": { alias: "scheduled-primary" },
              "example/fallback": { agentRuntime: { id: "agent-harness" } },
            },
          },
        ],
      },
    };
    const cfg = buildCronConfig(config);

    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "example",
        modelId: "primary",
        agentId: "worker",
      }),
    ).toBe("inherited-harness");
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "example",
        modelId: "fallback",
        agentId: "worker",
      }),
    ).toBe("agent-harness");
  });

  it("merges inherited default and model request parameters with agent-level precedence", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          params: { seed: 42, temperature: 0.2 },
          models: {
            "example/primary": { params: { maxTokens: 4096, temperature: 0.4 } },
          },
        },
        list: [
          {
            id: "worker",
            models: { "example/primary": { alias: "scheduled-primary" } },
            params: { temperature: 0.6 },
          },
        ],
      },
    };

    expect(
      resolveExtraParams({
        cfg: buildCronConfig(config),
        provider: "example",
        modelId: "primary",
        agentId: "worker",
      }),
    ).toEqual({ seed: 42, maxTokens: 4096, temperature: 0.6 });
  });
});
