import { expect, it } from "vitest";
import type { GatewayAgentRow } from "../../api/types.ts";
import { orderAgentSwitcherRows } from "./switcher-order.ts";

const row = (id: string): GatewayAgentRow => ({ id, name: id });
const agents = ["main", "alpha", "beta", "gamma", "delta"].map(row);

it("keeps roster order when nothing is pinned or being created", () => {
  expect(orderAgentSwitcherRows(agents, {})).toEqual(agents);
  expect(orderAgentSwitcherRows(agents, { pinnedAgentIds: [] })).toEqual(agents);
});

it("lists pinned agents first in pin order and leaves the rest in roster order", () => {
  expect(orderAgentSwitcherRows(agents, { pinnedAgentIds: ["delta", "alpha"] })).toEqual([
    row("delta"),
    row("alpha"),
    row("main"),
    row("beta"),
    row("gamma"),
  ]);
});

it("keeps a pinned or recently created agent ahead of the pins", () => {
  expect(
    orderAgentSwitcherRows(agents, {
      pinnedAgentIds: ["delta", "gamma"],
      recentlyCreatedAgentId: "beta",
    }),
  ).toEqual([row("beta"), row("delta"), row("gamma"), row("main"), row("alpha")]);
  expect(
    orderAgentSwitcherRows(agents, {
      pendingAgent: row("new"),
      pinnedAgentIds: ["delta"],
    }),
  ).toEqual([row("new"), row("delta"), row("main"), row("alpha"), row("beta"), row("gamma")]);
});

it("replaces a roster row with its pending version", () => {
  const pending = { ...row("beta"), name: "Beta (creating)" };
  expect(
    orderAgentSwitcherRows(agents, { pendingAgent: pending, pinnedAgentIds: ["alpha"] }),
  ).toEqual([pending, row("alpha"), row("main"), row("gamma"), row("delta")]);
});

it("ignores pins that name no roster agent and repeated pins", () => {
  expect(orderAgentSwitcherRows(agents, { pinnedAgentIds: ["ghost", "gamma", "gamma"] })).toEqual([
    row("gamma"),
    row("main"),
    row("alpha"),
    row("beta"),
    row("delta"),
  ]);
});

it("does not mutate the roster", () => {
  const before = structuredClone(agents);
  orderAgentSwitcherRows(agents, { pinnedAgentIds: ["delta"] });
  expect(agents).toEqual(before);
});
