import { describe, expect, it } from "vitest";
import { resolveExecCommandHighlighting } from "./exec-command-highlighting.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function configWithAgent(globalValue?: boolean, agentValue?: boolean): OpenClawConfig {
  return {
    tools: { exec: { commandHighlighting: globalValue } },
    agents: {
      list: [{ id: "alpha", tools: { exec: { commandHighlighting: agentValue } } }],
    },
  };
}

describe("resolveExecCommandHighlighting", () => {
  it("defaults to false when no config is provided", () => {
    expect(resolveExecCommandHighlighting({})).toBe(false);
  });

  it("reads global exec commandHighlighting", () => {
    const config = { tools: { exec: { commandHighlighting: true } } } satisfies OpenClawConfig;
    expect(resolveExecCommandHighlighting({ config })).toBe(true);
  });

  it.each([
    { globalValue: false, agentValue: true },
    { globalValue: true, agentValue: false },
  ])("agent-scoped $agentValue overrides global $globalValue", ({ globalValue, agentValue }) => {
    const config = configWithAgent(globalValue, agentValue);
    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(agentValue);
  });

  it("agent without override falls back to global true", () => {
    const config = {
      tools: { exec: { commandHighlighting: true } },
      agents: { list: [{ id: "alpha" }] },
    } satisfies OpenClawConfig;
    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(true);
  });

  it("agent ID normalization matches agent list entries", () => {
    expect(
      resolveExecCommandHighlighting({
        config: configWithAgent(undefined, true),
        agentId: "ALPHA",
      }),
    ).toBe(true);
  });

  it("unrelated agent ID does not affect the result", () => {
    expect(
      resolveExecCommandHighlighting({
        config: configWithAgent(undefined, true),
        agentId: "other",
      }),
    ).toBe(false);
  });
});
