import { expect, it } from "vitest";
import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { projectOperatorModelRead } from "./operator-model-presentation.js";
import type { GatewayClient } from "./server-methods/types.js";
import { projectModelFastModeCatalog } from "./session-fast-mode-presentation.js";

it("projects startup and decision catalog tiers per recipient without rewriting cached facts", () => {
  const legacy: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-ios", version: "2026.9.6", platform: "ios", mode: "ui" },
      role: "operator",
      scopes: ["operator.read"],
    },
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
