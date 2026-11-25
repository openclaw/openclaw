import { expect, it, vi } from "vitest";
import * as context from "../agents/context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionRuntimeResolution } from "./session-runtime-resolution.js";
import * as placement from "./worker-environments/placement-session-runtime.js";

it("shares equivalent automatic runtime values while preserving source and refresh boundaries", () => {
  using project = vi.spyOn(placement, "projectWorkerPlacementAgentRuntime");
  const read = createSessionRuntimeResolution({});
  const implicit = read.placement({ id: "openclaw", source: "implicit" });
  expect(read.placement({ id: "openclaw", source: "implicit" })).toEqual(implicit);
  expect(project).toHaveBeenCalledOnce();
  expect(read.placement({ id: "openclaw", source: "model" }).source).toBe("model");
  expect(project).toHaveBeenCalledTimes(2);
  expect(
    createSessionRuntimeResolution({}).placement({ id: "openclaw", source: "implicit" }),
  ).toEqual(implicit);
  expect(project).toHaveBeenCalledTimes(3);
});

it("shares prepared context facts only for the same model and capacities within a refresh", () => {
  using resolve = vi.spyOn(context, "resolveModelContextTokenProjection");
  const cfg: OpenClawConfig = {};
  const read = createSessionRuntimeResolution(cfg);
  const inputs = [
    { provider: "fixture", model: "first", modelContextTokens: 32768 },
    { provider: "other", model: "first", modelContextTokens: 32768 },
    { provider: "fixture", model: "second", modelContextTokens: 32768 },
    { provider: "fixture", model: "first", modelContextTokens: 8192 },
    { provider: "fixture", model: "first", modelContextTokens: 32768, modelContextWindow: 4096 },
  ];
  for (let pass = 0; pass < 3; pass++) {
    expect(inputs.map((input) => read.context(input).contextTokens)).toEqual([
      32768, 32768, 32768, 8192, 4096,
    ]);
  }
  expect(resolve).toHaveBeenCalledTimes(inputs.length);
  const next = createSessionRuntimeResolution({
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid",
          models: [
            {
              id: "first",
              name: "First",
              contextTokens: 2048,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
            },
          ],
        },
      },
    },
  });
  expect(next.context(inputs[0]!).contextTokens).toBe(2048);
  expect(read.context(inputs[0]!).contextTokens).toBe(32768);
  expect(resolve).toHaveBeenCalledTimes(inputs.length + 1);
});
