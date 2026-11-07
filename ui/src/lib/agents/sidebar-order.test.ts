import { expect, it } from "vitest";
import { moveSidebarAgent, orderSidebarAgents } from "./sidebar-order.ts";

it("preserves defaults, absent saved positions, and the relative order of new agents", () => {
  const agents = ["main", "research", "writing"].map((id) => ({ id }));
  expect(orderSidebarAgents(agents, [])).toEqual(agents);
  const saved = ["research", "unavailable", "main"];
  expect(orderSidebarAgents(agents, saved).map((agent) => agent.id)).toEqual([
    "research",
    "main",
    "writing",
  ]);
  const moved = moveSidebarAgent(
    saved,
    agents.map((agent) => agent.id),
    "writing",
    "research",
    "before",
  );
  expect(moved).toEqual(["writing", "research", "unavailable", "main"]);
  if (!moved) {
    throw new Error("Expected a saveable order");
  }
  expect(
    orderSidebarAgents([...agents, { id: "unavailable" }, { id: "new" }], moved).map(
      (agent) => agent.id,
    ),
  ).toEqual(["writing", "research", "unavailable", "main", "new"]);
  expect(saved).toEqual(["research", "unavailable", "main"]);
  expect(moveSidebarAgent(saved, ["main", "research"], "unavailable", "main", "before")).toEqual(
    saved,
  );
});
