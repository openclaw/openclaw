import { expect, it, vi } from "vitest";
import { runWithModelFallback } from "../agents/model-fallback-runner.js";
import { recordModelFallbackStop } from "./agent-harness-attempt-runtime.js";

it("preserves a harness fallback stop through wrapping and frozen errors", async () => {
  const transportError = Object.freeze(new Error("Native stream disconnected"));
  recordModelFallbackStop(transportError);
  const surfaced = new Error("Native recovery exhausted", { cause: transportError });
  const run = vi.fn(async () => {
    throw surfaced;
  });
  await expect(
    runWithModelFallback({
      provider: "fixture-primary",
      model: "fixture-model",
      manifestPlugins: [],
      fallbacksOverride: ["fixture-secondary/fixture-model"],
      run,
    }),
  ).rejects.toBe(surfaced);
  expect(run).toHaveBeenCalledOnce();
});
