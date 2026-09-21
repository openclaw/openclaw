import { describe, expect, it } from "vitest";
import type { AgentBinding, AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultAgentBoundAccountId } from "./bindings.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

function countRoleVisits<T>(memberRoleIds: string[], read: () => T) {
  const descriptor = Object.getOwnPropertyDescriptor(memberRoleIds, Symbol.iterator);
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
    if (descriptor) {
      Object.defineProperty(memberRoleIds, Symbol.iterator, descriptor);
    } else {
      Reflect.deleteProperty(memberRoleIds, Symbol.iterator);
    }
  }
}

describe("bound account selection work", () => {
  it.each(["peerless", "default"] as const)(
    "reads only the winning binding type from 10000 bindings (%s)",
    (selector) => {
      let typeReads = 0;
      const bindings: AgentRouteBinding[] = Array.from({ length: 10_000 }, (_, index) => ({
        get type() {
          typeReads += 1;
          return "route" as const;
        },
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: `account-${index}` },
      }));
      const cfg: OpenClawConfig = {
        agents: { entries: { "bot-alpha": {} } },
        bindings,
      };

      const result =
        selector === "peerless"
          ? resolveFirstBoundAccountId({ cfg, channelId: "matrix", agentId: "bot-alpha" })
          : resolveDefaultAgentBoundAccountId(cfg, "matrix");
      const reads = typeReads;

      expect(result).toBe("account-0");
      expect(cfg.bindings).toBe(bindings);
      expect(bindings).toHaveLength(10_000);
      expect(reads).toBe(1);
    },
  );

  it("visits 1000 caller roles once across 1000 role-scoped candidates", () => {
    const bindings: AgentRouteBinding[] = Array.from({ length: 1000 }, (_, index) => ({
      agentId: "bot-alpha",
      match: {
        channel: "discord",
        guildId: "guild-current",
        roles: [index === 999 ? "role-999" : "missing-role"],
        accountId: `account-${index}`,
      },
    }));
    const cfg: OpenClawConfig = { bindings };
    const memberRoleIds = Array.from({ length: 1000 }, (_, index) => `role-${index}`);
    const result = countRoleVisits(memberRoleIds, () =>
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "guild-current",
        memberRoleIds,
      }),
    );

    expect(result.value).toBe("account-999");
    expect(cfg.bindings).toBe(bindings);
    expect(bindings).toHaveLength(1000);
    expect(memberRoleIds).toEqual(Array.from({ length: 1000 }, (_, index) => `role-${index}`));
    expect(Object.hasOwn(memberRoleIds, Symbol.iterator)).toBe(false);
    expect({ iterations: result.iterations, visits: result.visits }).toEqual({
      iterations: 1,
      visits: 1000,
    });
  });

  it("does not prepare caller roles for mismatched spaces or unscoped bindings", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "bot-alpha",
          match: {
            channel: "discord",
            guildId: "other-guild",
            roles: ["admin"],
            accountId: "wrong-guild",
          },
        },
        {
          agentId: "bot-alpha",
          match: {
            channel: "discord",
            guildId: "current",
            teamId: "other-team",
            roles: ["admin"],
            accountId: "wrong-team",
          },
        },
        { agentId: "bot-alpha", match: { channel: "discord", accountId: "unscoped" } },
      ],
    };
    const memberRoleIds = ["admin"];
    const result = countRoleVisits(memberRoleIds, () =>
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "current",
        memberRoleIds,
      }),
    );

    expect(result.value).toBe("unscoped");
    expect(memberRoleIds).toEqual(["admin"]);
    expect(Object.hasOwn(memberRoleIds, Symbol.iterator)).toBe(false);
    expect({ iterations: result.iterations, visits: result.visits }).toEqual({
      iterations: 0,
      visits: 0,
    });
  });

  it("reads role and binding changes freshly on each invocation", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "bot-alpha",
          match: { channel: "discord", roles: ["admin"], accountId: "admin" },
        },
        { agentId: "bot-alpha", match: { channel: "discord", accountId: "general" } },
      ],
    };
    const params = {
      cfg,
      channelId: "discord",
      agentId: "bot-alpha",
      memberRoleIds: ["member"],
    };
    expect(resolveFirstBoundAccountId(params)).toBe("general");
    params.memberRoleIds[0] = "admin";
    expect(resolveFirstBoundAccountId(params)).toBe("admin");
    params.memberRoleIds = ["member"];
    expect(resolveFirstBoundAccountId(params)).toBe("general");
    cfg.bindings = [
      { agentId: "bot-alpha", match: { channel: "discord", accountId: "replacement" } },
    ];
    expect(resolveFirstBoundAccountId(params)).toBe("replacement");
  });

  it.each(["peerless", "default"] as const)(
    "keeps route type and explicit account requirements (%s)",
    (selector) => {
      const bindings: AgentBinding[] = [
        {
          type: "acp",
          agentId: "bot-alpha",
          match: { channel: "matrix", accountId: "acp", peer: { kind: "group", id: "room" } },
        },
        { agentId: "bot-alpha", match: { channel: "matrix" } },
        { agentId: "bot-alpha", match: { channel: "matrix", accountId: "*" } },
        { agentId: "other", match: { channel: "matrix", accountId: "other" } },
        { agentId: "bot-alpha", match: { channel: "matrix", accountId: "selected" } },
      ];
      const cfg: OpenClawConfig = {
        agents: { entries: { "bot-alpha": {} } },
        bindings,
      };
      const result =
        selector === "peerless"
          ? resolveFirstBoundAccountId({ cfg, channelId: " MATRIX ", agentId: "bot-alpha" })
          : resolveDefaultAgentBoundAccountId(cfg, " MATRIX ");
      expect(result).toBe("selected");
      expect(cfg.bindings).toBe(bindings);
    },
  );

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
