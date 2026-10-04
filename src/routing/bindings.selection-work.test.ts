import { describe, expect, it } from "vitest";
import type { AgentBinding, AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultAgentBoundAccountId } from "./bindings.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

function countRoleVisits<T>(memberRoleIds: string[], read: () => T) {
  const iterate = memberRoleIds[Symbol.iterator].bind(memberRoleIds);
  let iterations = 0;
  let visits = 0;
  Object.defineProperty(memberRoleIds, Symbol.iterator, {
    configurable: true,
    *value() {
      iterations += 1;
      for (const role of iterate()) {
        visits += 1;
        yield role;
      }
    },
  });
  try {
    const value = read();
    return { value, iterations, visits };
  } finally {
    Reflect.deleteProperty(memberRoleIds, Symbol.iterator);
  }
}

describe("bound account selection work", () => {
  it.each(["peerless", "default"] as const)(
    "skips ineligible bindings and stops at the first of 10000 eligible bindings (%s)",
    (selector) => {
      let typeReads = 0;
      const eligible: AgentRouteBinding[] = Array.from({ length: 10_000 }, (_, index) => ({
        get type() {
          typeReads += 1;
          return "route" as const;
        },
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: `account-${index}` },
      }));
      const bindings: AgentBinding[] = [
        {
          type: "acp",
          agentId: "bot-alpha",
          match: { channel: "matrix", accountId: "acp", peer: { kind: "group", id: "room" } },
        },
        { agentId: "bot-alpha", match: { channel: "matrix" } },
        { agentId: "bot-alpha", match: { channel: "matrix", accountId: "*" } },
        { agentId: "other", match: { channel: "matrix", accountId: "other" } },
        ...eligible,
      ];
      const cfg: OpenClawConfig = {
        agents: { entries: { "bot-alpha": {} } },
        bindings,
      };

      const result =
        selector === "peerless"
          ? resolveFirstBoundAccountId({ cfg, channelId: " MATRIX ", agentId: "bot-alpha" })
          : resolveDefaultAgentBoundAccountId(cfg, " MATRIX ");
      const reads = typeReads;

      expect(result).toBe("account-0");
      expect(cfg.bindings).toBe(bindings);
      expect(bindings).toHaveLength(10_004);
      expect(reads).toBe(1);
    },
  );

  it.each([true, false])("prepares caller roles once only for matching scopes (%s)", (matching) => {
    const match = (accountId: string, scope: Partial<AgentRouteBinding["match"]> = {}) => ({
      agentId: "bot-alpha",
      match: { channel: "discord", accountId, ...scope },
    });
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
    const result = countRoleVisits(memberRoleIds, () =>
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "current",
        memberRoleIds,
      }),
    );

    expect(result.value).toBe(matching ? "account-999" : "unscoped");
    expect(cfg.bindings).toBe(bindings);
    expect(bindings).toHaveLength(matching ? 1000 : 3);
    expect(memberRoleIds).toEqual(expectedRoles);
    expect({ iterations: result.iterations, visits: result.visits }).toEqual({
      iterations: matching ? 1 : 0,
      visits: matching ? 1000 : 0,
    });
  });

  it("retains early channel and default-owner guards without reading binding types", () => {
    let typeReads = 0;
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { one: {}, two: {} } },
      bindings: [
        {
          get type() {
            typeReads += 1;
            return "route" as const;
          },
          agentId: "one",
          match: { channel: "matrix", accountId: "work" },
        },
      ],
    };
    expect(resolveFirstBoundAccountId({ cfg, channelId: " ", agentId: "one" })).toBeUndefined();
    expect(resolveDefaultAgentBoundAccountId(cfg, " ")).toBeNull();
    expect(resolveDefaultAgentBoundAccountId(cfg, "matrix")).toBeNull();
    expect(typeReads).toBe(0);
  });
});
