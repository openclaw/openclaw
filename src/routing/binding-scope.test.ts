// Binding scope tests cover route binding scope matching and match resolution.
import { describe, expect, it } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { resolveNormalizedRouteBindingMatch, routeBindingScopeMatches } from "./binding-scope.js";

describe("routeBindingScopeMatches", () => {
  it("passes when the constraint has no guild/team/role limits", () => {
    expect(routeBindingScopeMatches({}, { guildId: "g1", teamId: "t1" })).toBe(true);
  });

  it("matches an exact guild id constraint", () => {
    expect(routeBindingScopeMatches({ guildId: "g1" }, { guildId: "g1" })).toBe(true);
  });

  it("matches an exact team id constraint", () => {
    expect(routeBindingScopeMatches({ teamId: "t1" }, { teamId: "t1" })).toBe(true);
  });

  it("falls back to the group space when guild/team ids are absent", () => {
    expect(routeBindingScopeMatches({ guildId: "space-1" }, { groupSpace: "space-1" })).toBe(true);
    expect(routeBindingScopeMatches({ teamId: "space-1" }, { groupSpace: "space-1" })).toBe(true);
  });

  it("fails when the guild id constraint does not match", () => {
    expect(routeBindingScopeMatches({ guildId: "g1" }, { guildId: "g2" })).toBe(false);
  });

  it("fails when the team id constraint does not match", () => {
    expect(routeBindingScopeMatches({ teamId: "t1" }, { teamId: "t2" })).toBe(false);
  });
});

describe("routeBindingScopeMatches role intersection", () => {
  it("accepts a Set of member role ids", () => {
    expect(
      routeBindingScopeMatches(
        { roles: ["admin"] },
        { memberRoleIds: new Set(["member", "admin"]) },
      ),
    ).toBe(true);
    expect(
      routeBindingScopeMatches({ roles: ["admin"] }, { memberRoleIds: new Set(["member"]) }),
    ).toBe(false);
  });

  it("accepts an iterable of member role ids", () => {
    expect(
      routeBindingScopeMatches({ roles: ["admin"] }, { memberRoleIds: ["member", "admin"] }),
    ).toBe(true);
    expect(routeBindingScopeMatches({ roles: ["admin"] }, { memberRoleIds: ["member"] })).toBe(
      false,
    );
  });

  it("fails role-constrained bindings when no member role ids are provided", () => {
    expect(routeBindingScopeMatches({ roles: ["admin"] }, {})).toBe(false);
  });

  it("ignores empty role lists as unconstrained", () => {
    expect(routeBindingScopeMatches({ roles: [] }, {})).toBe(true);
  });
});

describe("resolveNormalizedRouteBindingMatch", () => {
  function bindingWith(accountId: string | undefined, channel: string): AgentRouteBinding {
    return {
      agentId: "Main",
      match: { channel, accountId },
    };
  }

  it("resolves a concrete account binding into canonical ids", () => {
    expect(resolveNormalizedRouteBindingMatch(bindingWith("Bot-Alpha", "discord"))).toEqual({
      agentId: "main",
      accountId: "bot-alpha",
      channelId: "discord",
    });
  });

  it("rejects wildcard account matches", () => {
    expect(resolveNormalizedRouteBindingMatch(bindingWith("*", "discord"))).toBeNull();
  });

  it("rejects empty account matches", () => {
    expect(resolveNormalizedRouteBindingMatch(bindingWith("   ", "discord"))).toBeNull();
  });

  it("rejects blank channel matches", () => {
    expect(resolveNormalizedRouteBindingMatch(bindingWith("bot-alpha", "   "))).toBeNull();
  });
});
