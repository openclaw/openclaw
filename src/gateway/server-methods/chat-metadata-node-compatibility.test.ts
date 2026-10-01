import { expect, it } from "vitest";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";

it("keeps gateway CLI readiness off node choices while preserving a direct API route", () => {
  const models: ModelChoice[] = [
    { provider: "claude-cli", id: "new-model", name: "New", available: true },
    {
      provider: "anthropic",
      id: "new-model",
      name: "New",
      available: true,
      agentRuntime: { id: "openclaw", source: "implicit" },
      runtimeChoices: [
        {
          agentRuntime: { id: "claude-cli", source: "implicit" },
          available: false,
          unavailableReason: "cooldown",
          unavailableUntil: 123,
        },
        { agentRuntime: { id: "openclaw", source: "implicit" }, available: true },
      ],
    },
  ];
  const projected = projectSessionModelCatalog(
    { agentId: "main", sessionEntry: { execHost: "node", execNode: "fixture-node" } },
    models,
    {},
  );
  expect(projected[0]).toEqual({ provider: "claude-cli", id: "new-model", name: "New" });
  expect(projected[1]?.available).toBe(true);
  expect(projected[1]?.runtimeChoices).toEqual([
    { agentRuntime: { id: "claude-cli", source: "implicit" } },
    { agentRuntime: { id: "openclaw", source: "implicit" }, available: true },
  ]);
  expect(models[0]?.available).toBe(true);
});
