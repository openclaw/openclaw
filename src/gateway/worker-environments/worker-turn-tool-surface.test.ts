import { expect, it } from "vitest";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import { filterWorkerPlacementTools } from "./worker-turn-tool-surface.js";

it("withholds sessions_yield when the run has no yield owner", () => {
  const tools = [createSessionsYieldTool({ sessionId: "session" })];

  expect(filterWorkerPlacementTools(tools, new Set(), [])).toEqual([]);
});

it("keeps sessions_yield when the run has a yield owner", () => {
  const tools = [createSessionsYieldTool({ sessionId: "session", onYield: () => {} })];

  expect(filterWorkerPlacementTools(tools, new Set(), [])).toEqual(tools);
});
