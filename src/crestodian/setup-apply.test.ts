import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyCrestodianModelSelection } from "./setup-apply.js";

describe("applyCrestodianModelSelection", () => {
  it("clears stale harness pins when switching to a native provider route", async () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
        list: [
          {
            id: "work",
            default: true,
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                alias: "primary",
                agentRuntime: { id: "codex" },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = await applyCrestodianModelSelection({
      config,
      model: "openai/gpt-5.5",
    });

    expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
    expect(result.agents?.list?.[0]?.models?.["openai/gpt-5.5"]).toEqual({ alias: "primary" });
    expect(result.agents?.list?.[0]?.model).toBe("openai/gpt-5.5");
  });
});
