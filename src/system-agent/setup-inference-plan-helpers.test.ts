import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applySystemAgentModelSelection } from "./setup-apply.js";
import { resolveSetupModelSelectionTargetAgentId } from "./setup-inference-plan-helpers.js";

describe("resolveSetupModelSelectionTargetAgentId", () => {
  it("stages a multi-agent list roster onto its explicit route", async () => {
    const config = {
      agents: {
        list: [
          { id: "ops", model: "openai/gpt-5.4" },
          { id: "research", model: "openai/gpt-5.3" },
        ],
      },
    } satisfies OpenClawConfig;
    const targetAgentId = resolveSetupModelSelectionTargetAgentId(config, "Ops");

    expect(targetAgentId).toBe("ops");
    const staged = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
      targetAgentId,
    });
    expect(staged.agents?.entries?.ops?.model).toBe("openai/gpt-5.5");
    expect(staged.agents?.entries?.research?.model).toBe("openai/gpt-5.3");
  });
});
