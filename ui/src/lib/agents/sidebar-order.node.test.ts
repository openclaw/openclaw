import { describe, expect, it } from "vitest";
import {
  moveSidebarAgent,
  normalizeSidebarAgentOrder,
  orderSidebarAgents,
} from "./sidebar-order.ts";

describe("team-sidebar agent order", () => {
  const agents = [{ id: "main" }, { id: "zeta" }, { id: "alpha" }];
  it("preserves the default projection and explicitly overrides default promotion", () => {
    expect(orderSidebarAgents(agents, [])).toEqual(agents);
    expect(orderSidebarAgents(agents, ["zeta"])).toEqual([agents[1], agents[0], agents[2]]);
    expect(agents.map((a) => a.id)).toEqual(["main", "zeta", "alpha"]);
  });
  it("normalizes duplicates and invalid values without filtering missing agents", () => {
    expect(normalizeSidebarAgentOrder(["zeta", null, "", " zeta ", 2, "missing"])).toEqual([
      "zeta",
      "missing",
    ]);
    expect(normalizeSidebarAgentOrder("zeta")).toBeUndefined();
    expect(orderSidebarAgents(agents, ["missing", "alpha"]).map((a) => a.id)).toEqual([
      "alpha",
      "main",
      "zeta",
    ]);
  });
  it("retains missing IDs during moves, including when their agents return", () => {
    const order = moveSidebarAgent(
      ["missing", "main", "zeta"],
      agents.map((a) => a.id),
      "alpha",
      "main",
      "before",
    );
    expect(order).toEqual(["missing", "alpha", "main", "zeta"]);
    expect(orderSidebarAgents([...agents, { id: "missing" }], order).map((a) => a.id)).toEqual(
      order,
    );
  });
  it("moves in both directions without changing other relative order", () => {
    expect(
      moveSidebarAgent(
        [],
        agents.map((a) => a.id),
        "main",
        "alpha",
        "after",
      ),
    ).toEqual(["zeta", "alpha", "main"]);
    expect(
      moveSidebarAgent(
        [],
        agents.map((a) => a.id),
        "alpha",
        "main",
        "before",
      ),
    ).toEqual(["alpha", "main", "zeta"]);
  });
});
