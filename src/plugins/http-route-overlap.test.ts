import { describe, expect, it } from "vitest";
import { doPluginHttpRoutesOverlap, findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import type { OpenClawPluginHttpRouteMatch } from "./types.js";

function route(path: string, match: OpenClawPluginHttpRouteMatch) {
  return { path, match };
}

describe("doPluginHttpRoutesOverlap", () => {
  describe("exact-exact", () => {
    it("returns true when paths are identical", () => {
      expect(doPluginHttpRoutesOverlap(route("/foo", "exact"), route("/foo", "exact"))).toBe(true);
    });

    it("returns false when paths differ", () => {
      expect(doPluginHttpRoutesOverlap(route("/foo", "exact"), route("/bar", "exact"))).toBe(false);
    });

    it("canonicalizes paths before comparing", () => {
      expect(doPluginHttpRoutesOverlap(route("/foo/", "exact"), route("/foo", "exact"))).toBe(true);
    });
  });

  describe("prefix-prefix", () => {
    it("returns true when one prefix is nested under the other", () => {
      expect(doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/api/v1", "prefix"))).toBe(
        true,
      );
    });

    it("returns true when prefixes are identical", () => {
      expect(doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/api", "prefix"))).toBe(
        true,
      );
    });

    it("returns false when prefixes do not overlap", () => {
      expect(doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/webhook", "prefix"))).toBe(
        false,
      );
    });
  });

  describe("prefix-exact", () => {
    it("returns true when exact path falls under prefix", () => {
      expect(doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/api/users", "exact"))).toBe(
        true,
      );
    });

    it("returns true regardless of argument order", () => {
      expect(doPluginHttpRoutesOverlap(route("/api/users", "exact"), route("/api", "prefix"))).toBe(
        true,
      );
    });

    it("returns false when exact path is outside prefix", () => {
      expect(
        doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/webhook/hook1", "exact")),
      ).toBe(false);
    });

    it("returns true when exact path matches prefix path exactly", () => {
      expect(doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/api", "exact"))).toBe(true);
    });
  });

  describe("non-overlapping paths", () => {
    it("returns false for completely disjoint paths", () => {
      expect(doPluginHttpRoutesOverlap(route("/alpha", "prefix"), route("/beta", "exact"))).toBe(
        false,
      );
    });

    it("does not match partial path segments", () => {
      // "/api" prefix should not match "/api-v2" since "api-v2" is not under "api/"
      expect(doPluginHttpRoutesOverlap(route("/api", "prefix"), route("/api-v2", "exact"))).toBe(
        false,
      );
    });
  });
});

describe("findOverlappingPluginHttpRoute", () => {
  it("returns the first overlapping route", () => {
    const routes = [route("/alpha", "exact"), route("/api", "prefix"), route("/beta", "exact")];
    const result = findOverlappingPluginHttpRoute(routes, route("/api/users", "exact"));
    expect(result).toEqual(route("/api", "prefix"));
  });

  it("returns undefined when no route overlaps", () => {
    const routes = [route("/alpha", "exact"), route("/beta", "prefix")];
    const result = findOverlappingPluginHttpRoute(routes, route("/gamma", "exact"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty route list", () => {
    const result = findOverlappingPluginHttpRoute([], route("/anything", "exact"));
    expect(result).toBeUndefined();
  });

  it("only returns the first match when multiple routes overlap", () => {
    const routes = [
      route("/api", "prefix"),
      route("/api/v1", "prefix"),
      route("/api/v1/users", "exact"),
    ];
    const result = findOverlappingPluginHttpRoute(routes, route("/api/v1/users", "exact"));
    // First route in the array that overlaps wins
    expect(result).toEqual(route("/api", "prefix"));
  });
});
