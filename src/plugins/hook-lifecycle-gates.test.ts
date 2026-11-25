import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHookRegistration } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";

type GateHandler = PluginHookRegistration<"before_agent_run">["handler"];
function runGate(hooks: [string, GateHandler, number?][] = []) {
  return createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: hooks.map<PluginHookRegistration<"before_agent_run">>(
      ([pluginId, handler, priority]) => ({
        pluginId,
        handler,
        priority,
        hookName: "before_agent_run",
        source: "test",
      }),
    ),
  }).runBeforeAgentRun({ prompt: "test", messages: [] }, {});
}

describe("before_agent_run hook", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("allows inference with void handler registered=%s", async (registered) => {
    expect(
      await runGate(registered ? [["void-plugin", async () => undefined]] : []),
    ).toBeUndefined();
  });

  it.each([false, true])("blocks and short-circuits with block first=%s", async (blockFirst) => {
    const calls: string[] = [];
    const handler = (outcome: "pass" | "block") =>
      vi.fn(async () => {
        calls.push(outcome);
        return outcome === "pass" ? { outcome } : { outcome, reason: "blocked" };
      });
    const pass = handler("pass");
    const block = handler("block");
    const result = await runGate([
      ["pass-plugin", pass, blockFirst ? 5 : 10],
      ["block-plugin", block, blockFirst ? 10 : 5],
    ]);
    expect(result).toMatchObject({ decision: { outcome: "block" }, pluginId: "block-plugin" });
    expect(block).toHaveBeenCalledOnce();
    expect(pass).toHaveBeenCalledTimes(blockFirst ? 0 : 1);
    expect(calls).toEqual(blockFirst ? ["block"] : ["pass", "block"]);
  });

  it.each([
    ["null", null],
    ["ask", { outcome: "ask", reason: "check", title: "Check", description: "Check this." }],
  ] as const)("fails closed and short-circuits %s decisions", async (_name, decision) => {
    const later = vi.fn(async () => ({ outcome: "pass" as const }));
    expect(
      await runGate([
        ["invalid-plugin", async () => decision as never, 10],
        ["later", later, 5],
      ]),
    ).toEqual({
      decision: { outcome: "block", reason: "before_agent_run returned an invalid decision" },
      pluginId: "invalid-plugin",
    });
    expect(later).not.toHaveBeenCalled();
  });

  it("fails closed when handlers throw", async () => {
    await expect(
      runGate([
        [
          "throwing-plugin",
          async () => {
            throw new Error("policy unavailable");
          },
        ],
      ]),
    ).rejects.toThrow("before_agent_run handler from throwing-plugin failed: policy unavailable");
  });

  it("fails closed when handlers exceed the default timeout", async () => {
    vi.useFakeTimers();
    const result = runGate([["hanging-plugin", () => new Promise<never>(() => {})]]);
    const rejection = expect(result).rejects.toThrow(
      "before_agent_run handler from hanging-plugin failed: timed out after 15000ms",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
});
