import { expect, it } from "vitest";
import { projectHookTurnTaint } from "./hook-turn-taint.js";

it.each([
  "before_prompt_build", "llm_input", "llm_output", "before_agent_finalize",
  "agent_end", "before_compaction", "after_compaction",
] as const)("distinguishes unmeasured and measured turn taint on %s", (hook) => {
  expect(projectHookTurnTaint(hook, {})).toEqual({ turnTainted: "unknown" });
  for (const value of [false, true, "unknown"] as const) {
    expect(projectHookTurnTaint(hook, { turnTainted: value })).toEqual({ turnTainted: value });
  }
});

it.each(["agent_turn_prepare", "before_agent_run", "after_tool_call"] as const)(
  "does not expose a shared snapshot on %s", (hook) => {
    const ctx = Object.freeze({ runId: "r", turnTainted: true });
    expect(projectHookTurnTaint(hook, ctx)).toEqual({ runId: "r" });
    expect(ctx.turnTainted).toBe(true);
  },
);
