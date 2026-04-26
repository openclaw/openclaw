import { describe, expect, it } from "vitest";
import { routeBindingScopeMatches, type RouteBindingScope } from "./binding-scope.js";

describe("routeBindingScopeMatches", () => {
  it("does not read groupSpace when no guild or team constraint exists", () => {
    let groupSpaceReads = 0;
    const scope: RouteBindingScope = {
      get groupSpace() {
        groupSpaceReads += 1;
        return "guild-1";
      },
      memberRoleIds: new Set(["admin"]),
    };

    expect(routeBindingScopeMatches({ roles: ["admin"] }, scope)).toBe(true);
    expect(groupSpaceReads).toBe(0);
  });

  it("reads groupSpace once when guild and team constraints both need it", () => {
    let groupSpaceReads = 0;
    const scope: RouteBindingScope = {
      get groupSpace() {
        groupSpaceReads += 1;
        return "shared-space";
      },
    };

    expect(
      routeBindingScopeMatches(
        {
          guildId: "shared-space",
          teamId: "shared-space",
        },
        scope,
      ),
    ).toBe(true);
    expect(groupSpaceReads).toBe(1);
  });
});
