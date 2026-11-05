import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const event = { payload: { input: "source" }, provider: "fixture", model: "fixture", messages: [] };
describe("before_model_request", () => {
  it("awaits replacements in priority order", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_model_request",
          priority: 10,
          handler: async (input: unknown) => ({
            payload: { ...(input as typeof event).payload, input: "held" },
          }),
        },
        {
          hookName: "before_model_request",
          handler: async (input: unknown) => ({
            payload: {
              ...(input as typeof event).payload,
              observed: (input as typeof event).payload.input,
            },
          }),
        },
      ]),
    );
    expect(await runner.runBeforeModelRequest(event, {})).toEqual({
      payload: { input: "held", observed: "held" },
    });
  });
  it("does not send the original when a policy hook fails", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_model_request",
          handler: async () => {
            throw new Error("policy failed");
          },
        },
      ]),
    );
    await expect(runner.runBeforeModelRequest(event, {})).rejects.toThrow("policy failed");
  });
});
