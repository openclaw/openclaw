import { describe, expect, it } from "vitest";
import { resolveExecCommandHighlighting } from "./exec-command-highlighting.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function configWithAgent(globalValue?: boolean, agentValue?: boolean): OpenClawConfig {
  return {
    tools: { exec: { commandHighlighting: globalValue } },
    agents: {
      entries: { alpha: { tools: { exec: { commandHighlighting: agentValue } } } },
    },
  };
}

describe("resolveExecCommandHighlighting", () => {
  it("defaults to false when no config is provided", () => {
    expect(resolveExecCommandHighlighting({})).toBe(false);
  });

  it.each([{ globalValue: false, agentValue: true }])(
    "agent-scoped $agentValue overrides global $globalValue",
    ({ globalValue, agentValue }) => {
      const config = configWithAgent(globalValue, agentValue);
      expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(agentValue);
    },
  );
});
