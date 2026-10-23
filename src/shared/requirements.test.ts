import { expect, it } from "vitest";
import { evaluateRequirementsFromMetadataWithRemote } from "./requirements.js";

type EvaluationParams = Parameters<typeof evaluateRequirementsFromMetadataWithRemote>[0];

function evaluate(overrides: Partial<EvaluationParams> = {}) {
  return evaluateRequirementsFromMetadataWithRemote({
    always: false,
    hasLocalBin: () => false,
    localPlatform: "linux",
    isEnvSatisfied: () => false,
    isConfigSatisfied: () => false,
    ...overrides,
  });
}

it("requires at least one any-bin locally or remotely", () => {
  const metadata = { requires: { anyBins: ["a", "b"] } };

  expect(evaluate({ metadata }).missing.anyBins).toEqual(["a", "b"]);
  expect(evaluate({ metadata, hasLocalBin: (bin) => bin === "b" }).missing.anyBins).toStrictEqual(
    [],
  );
  const remote = { hasAnyBin: (bins: string[]) => bins.includes("b") };
  expect(evaluate({ metadata, remote }).missing.anyBins).toStrictEqual([]);
});

it("normalizes macos and accepts local or remote platforms", () => {
  const missingOs = (os: string, overrides: Partial<EvaluationParams> = {}) =>
    evaluate({ metadata: { os: [os] }, ...overrides }).missing.os;
  expect(missingOs("linux")).toStrictEqual([]);
  expect(missingOs("macos", { localPlatform: "darwin" })).toStrictEqual([]);
  expect(missingOs("macos", { remote: { platforms: ["darwin"] } })).toStrictEqual([]);
  expect(missingOs("darwin")).toEqual(["darwin"]);
});

it("reports every missing category through the public wrapper", () => {
  const required = {
    bins: ["node"],
    anyBins: ["bun", "deno"],
    env: ["OPENAI_API_KEY", "PRESENT"],
    config: ["browser.enabled", "gateway.enabled"],
    os: ["darwin"],
  };
  const { os, ...requires } = required;
  const result = evaluate({
    metadata: { requires, os },
    remote: {
      hasBin: (bin) => bin === "node",
      hasAnyBin: () => false,
      platforms: ["windows"],
    },
    isEnvSatisfied: (name) => name === "PRESENT",
    isConfigSatisfied: (path) => path === "gateway.enabled",
  });

  expect(result).toEqual({
    required,
    missing: {
      bins: [],
      anyBins: ["bun", "deno"],
      env: ["OPENAI_API_KEY"],
      config: ["browser.enabled"],
      os: ["darwin"],
    },
    configChecks: [
      { path: "browser.enabled", satisfied: false },
      { path: "gateway.enabled", satisfied: true },
    ],
    eligible: false,
  });
});

it.each(["linux", "darwin"])("always bypasses runtime requirements but respects OS %s", (os) => {
  const requires = {
    bins: ["node"],
    anyBins: ["bun"],
    env: ["OPENAI_API_KEY"],
    config: ["browser.enabled"],
  };
  expect(evaluate({ always: true, metadata: { requires, os: [os] } })).toEqual({
    required: { ...requires, os: [os] },
    missing: { bins: [], anyBins: [], env: [], config: [], os: os === "linux" ? [] : [os] },
    configChecks: [{ path: "browser.enabled", satisfied: false }],
    eligible: os === "linux",
  });
});
