import { expect, it } from "vitest";
import type { PluginHookAgentContext, PluginHookName } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const supported = [
  "before_prompt_build",
  "llm_input",
  "llm_output",
  "before_agent_finalize",
  "agent_end",
  "before_compaction",
  "after_compaction",
] as const satisfies readonly PluginHookName[];
const prompt = { prompt: "probe", messages: [] };
const model = { runId: "run", sessionId: "session", model: "model", provider: "provider" };

it.each([undefined, false, true, "unknown"] as const)(
  "delivers measurement %s only on the intended hooks",
  async (measurement) => {
    const hooks = [...supported, "before_reset", "agent_turn_prepare"] as const;
    const seen = new Map<string, unknown>();
    const runner = createHookRunner(
      createMockPluginRegistry(
        hooks.map((hookName) => ({
          hookName,
          conversationAccessAllowed: true,
          handler: (_event, ctx) => {
            seen.set(hookName, ctx);
          },
        })),
      ),
    );
    const ctx: PluginHookAgentContext = Object.freeze({
      runId: "run",
      ...(measurement === undefined ? {} : { turnTainted: measurement }),
    });
    await runner.runBeforePromptBuild(prompt, ctx);
    await runner.runLlmInput(
      { ...model, prompt: "probe", historyMessages: [], imagesCount: 0 },
      ctx,
    );
    await runner.runLlmOutput({ ...model, assistantTexts: [] }, ctx);
    await runner.runBeforeAgentFinalize({ ...model, stopHookActive: false }, ctx);
    await runner.runAgentEnd({ messages: [], success: true }, ctx);
    await runner.runBeforeCompaction({ messageCount: 1 }, ctx);
    await runner.runAfterCompaction({ messageCount: 1, compactedCount: 1 }, ctx);
    await runner.runBeforeReset({}, ctx);
    await runner.runAgentTurnPrepare({ ...prompt, queuedInjections: [] }, ctx);
    expect([...seen.keys()]).toEqual(hooks);
    for (const hook of supported)
      expect(seen.get(hook)).toHaveProperty("turnTainted", measurement ?? "unknown");
    for (const hook of ["before_reset", "agent_turn_prepare"])
      expect(seen.get(hook)).not.toHaveProperty("turnTainted");
    expect(ctx.turnTainted).toBe(measurement);
  },
);
