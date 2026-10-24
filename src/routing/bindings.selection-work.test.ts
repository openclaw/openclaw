import { beforeEach, expect, it, vi } from "vitest";
import type { AgentBinding, AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultAgentBoundAccountId } from "./bindings.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

type Match = Partial<AgentRouteBinding["match"]>;
const binding = (accountId?: string, scope: Match = {}, agentId = "bot-alpha") => ({
  agentId,
  match: { channel: "matrix", accountId, ...scope },
});
const match = (accountId: string, scope: Match = {}) =>
  binding(accountId, { channel: "discord", ...scope });

const typeReads = vi.fn(() => "route" as const);
beforeEach(() => void typeReads.mockClear());
const tracked = (entry: AgentRouteBinding) =>
  Object.defineProperty(entry, "type", { get: typeReads });

function countRoleVisits<T>(memberRoleIds: string[], read: () => T) {
  const visit = vi.fn((role: string) => role);
  const iter = vi.spyOn(memberRoleIds, Symbol.iterator).mockImplementation(function* () {
    for (const role of memberRoleIds.values()) {
      yield visit(role);
    }
    return undefined;
  });
  try {
    return { value: read(), iterations: iter.mock.calls.length, visits: visit.mock.calls.length };
  } finally {
    iter.mockRestore();
  }
}

it.each(["peerless", "default"] as const)(
  "skips ineligible bindings and stops at the first of 10000 eligible bindings (%s)",
  (selector) => {
    const eligible = Array.from({ length: 10_000 }, (_, i) => tracked(binding(`account-${i}`)));
    const bindings: AgentBinding[] = [
      { ...binding("acp", { peer: { kind: "group", id: "room" } }), type: "acp" },
      binding(),
      binding("*"),
      binding("other", {}, "other"),
      ...eligible,
    ];
    const cfg: OpenClawConfig = { agents: { entries: { "bot-alpha": {} } }, bindings };

    const result =
      selector === "peerless"
        ? resolveFirstBoundAccountId({ cfg, channelId: " MATRIX ", agentId: "bot-alpha" })
        : resolveDefaultAgentBoundAccountId(cfg, " MATRIX ");
    expect(result).toBe("account-0");
    expect(cfg.bindings).toBe(bindings);
    expect(bindings).toHaveLength(10_004);
    expect(typeReads).toHaveBeenCalledTimes(1);
  },
);

it.each([true, false])("prepares caller roles once only for matching scopes (%s)", (matching) => {
  const bindings = matching
    ? Array.from({ length: 1000 }, (_, index) =>
        match(`account-${index}`, {
          guildId: "current",
          roles: [index === 999 ? "role-999" : "missing-role"],
        }),
      )
    : [
        match("wrong-guild", { guildId: "other-guild", roles: ["admin"] }),
        match("wrong-team", { guildId: "current", teamId: "other-team", roles: ["admin"] }),
        match("unscoped"),
      ];
  const cfg: OpenClawConfig = { bindings };
  const expectedRoles = matching
    ? Array.from({ length: 1000 }, (_, index) => `role-${index}`)
    : ["admin"];
  const memberRoleIds = [...expectedRoles];
  const select = () =>
    resolveFirstBoundAccountId({
      cfg,
      channelId: "discord",
      agentId: "bot-alpha",
      groupSpace: "current",
      memberRoleIds,
    });
  expect(countRoleVisits(memberRoleIds, select)).toEqual({
    value: matching ? "account-999" : "unscoped",
    iterations: matching ? 1 : 0,
    visits: matching ? 1000 : 0,
  });
  expect(cfg.bindings).toBe(bindings);
  expect(bindings).toHaveLength(matching ? 1000 : 3);
  expect(memberRoleIds).toEqual(expectedRoles);
  if (matching) {
    memberRoleIds[999] = "other-role";
    expect(select()).toBeUndefined();
    memberRoleIds[999] = "role-999";
    expect(select()).toBe("account-999");
    cfg.bindings = [match("replacement")];
    expect(select()).toBe("replacement");
  }
});

it("retains early channel and default-owner guards without reading binding types", () => {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { one: {}, two: {} } },
    bindings: [tracked(binding("work", {}, "one"))],
  };
  expect(resolveFirstBoundAccountId({ cfg, channelId: " ", agentId: "one" })).toBeUndefined();
  expect(resolveDefaultAgentBoundAccountId(cfg, " ")).toBeNull();
  expect(resolveDefaultAgentBoundAccountId(cfg, "matrix")).toBeNull();
  expect(typeReads).not.toHaveBeenCalled();
});
