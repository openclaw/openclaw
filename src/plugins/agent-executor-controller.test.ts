import { expect, it } from "vitest";
import { resolveAgentExecutorController } from "./agent-executor-controller.js";

it("rejects published controller lookups with an actionable retirement error", () => {
  expect(() => resolveAgentExecutorController("remote-executor")).toThrow(
    expect.objectContaining({
      code: "PLUGIN_CAPABILITY_REMOVED",
      capability: "api.registerAgentExecutorController",
      message: expect.stringContaining('Executor controller "remote-executor" is unavailable'),
    }),
  );
});
