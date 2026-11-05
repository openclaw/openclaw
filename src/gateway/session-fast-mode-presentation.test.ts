import { expect, it } from "vitest";
import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { projectOperatorModelRead } from "./operator-model-presentation.js";
import type { GatewayClient } from "./server-methods/types.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
import { projectModelFastModeCatalog } from "./session-fast-mode-presentation.js";

it("projects startup and decision catalog tiers per recipient without rewriting cached facts", () => {
  const legacy: GatewayClient = {
    connect: gatewayConnect(["operator.read"], {
      id: "openclaw-ios",
      version: "2026.9.6",
      platform: "ios",
      mode: "ui",
    }),
  };
  const current: GatewayClient = { ...legacy, connect: { ...legacy.connect, caps: ["ultrafast"] } };
  const model: ModelChoice = {
    id: "fixture",
    provider: "fixture",
    name: "Fixture",
    effectiveFastMode: "ultrafast",
    runtimeChoices: [
      { agentRuntime: { id: "codex", source: "model" }, effectiveFastMode: "ultrafast" },
    ],
  };
  const catalog = { models: [model], decisionModels: [model] };
  const projected = projectModelFastModeCatalog(catalog, legacy);
  expect(projected.models[0]?.effectiveFastMode).toBe(true);
  expect(projected.models[0]?.runtimeChoices?.[0]?.effectiveFastMode).toBe(true);
  expect(projected.decisionModels[0]?.effectiveFastMode).toBe(true);
  expect(projectModelFastModeCatalog(catalog, current)).toBe(catalog);
  const payload = { metadata: { swarmEnabled: false, models: [model] } };
  const scope = { agentId: "main", context: { getRuntimeConfig: () => ({}) } };
  expect(
    projectOperatorModelRead({ ...scope, client: legacy }, payload).metadata.models[0]
      ?.effectiveFastMode,
  ).toBe(true);
  expect(
    projectOperatorModelRead({ ...scope, client: current }, payload).metadata.models[0]
      ?.effectiveFastMode,
  ).toBe("ultrafast");
  expect(model.effectiveFastMode).toBe("ultrafast");
  expect(model.runtimeChoices?.[0]?.effectiveFastMode).toBe("ultrafast");
});

it("retains catalog rows and runtime choices that need no legacy speed conversion", () => {
  const legacy: GatewayClient = { connect: gatewayConnect(["operator.read"]) };
  const unchanged: ModelChoice = {
    id: "ordinary",
    provider: "fixture",
    name: "Ordinary",
    effectiveFastMode: "auto",
    runtimeChoices: [
      { agentRuntime: { id: "openclaw", source: "model" }, effectiveFastMode: true },
    ],
  };
  const changed: ModelChoice = { ...unchanged, id: "fast", effectiveFastMode: "ultrafast" };
  const catalog = { models: [unchanged, changed], decisionModels: [unchanged] };
  const before = JSON.stringify(catalog);
  const projected = projectModelFastModeCatalog(catalog, legacy);
  expect(JSON.stringify(projected)).toBe(
    JSON.stringify({
      models: [unchanged, { ...changed, effectiveFastMode: true }],
      decisionModels: [unchanged],
    }),
  );
  expect(projected.models[0]).toBe(unchanged);
  expect(projected.models[1]?.runtimeChoices).toBe(unchanged.runtimeChoices);
  expect(projected.decisionModels[0]).toBe(unchanged);
  expect(JSON.stringify(catalog)).toBe(before);
});
