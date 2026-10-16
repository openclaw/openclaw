import { expect, it, vi } from "vitest";
import { resolveAgentCatalogCreateTarget } from "./runtime-agent-session-catalog.js";

vi.mock("../../agents/model-selection.js", () => {
  throw new Error("Catalog targets must not load unrelated model-selection owners.");
});

it("resolves an empty catalog without loading the model-selection facade", () => {
  expect(
    resolveAgentCatalogCreateTarget({
      config: {},
      provider: "test",
      modelIds: [],
      agentRuntime: "openclaw",
    }),
  ).toBeUndefined();
});
