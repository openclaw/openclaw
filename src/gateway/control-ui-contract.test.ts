import { describe, expect, it } from "vitest";
import {
  buildControlUiResourcePath as buildPath,
  buildControlUiUserAvatarPath as buildAvatarPath,
  canonicalizeControlUiUserAvatarPath as canonicalizeAvatar,
  matchControlUiResourceUrl as matchUrl,
  parseControlUiUserAvatarPath as parseAvatar,
  parseControlUiResourcePath as parsePath,
} from "./control-ui-contract.js";

const matched = (value: string | null) => ({ matched: true, value });
const urlMatch = (value: string, search = "", hash = "") => ({ value, search, hash });

describe("Control UI resource route contract", () => {
  it.each([
    ["agentAvatar", "ops/main", "/avatar/ops%2Fmain"],
    ["userAvatar", "profile/a b", "/api/users/profile%2Fa%20b/avatar"],
  ] as const)("round-trips %s as one encoded segment", (route, value, path) => {
    expect(buildPath(route, "", value)).toBe(path);
    expect(buildPath(route, "control/", value)).toBe(`/control${path}`);
    expect(parsePath(route, path)).toEqual(matched(value));
    expect(parsePath(route, `/control${path}`, "/control/")).toEqual(matched(value));
  });

  it("preserves scoped plugin IDs and artwork components", () => {
    const pathname = "/control/__openclaw__/plugin-theme-art/%40scope%2Fpack/neon/hat/beret";
    const segments = ["neon", "hat", "beret"];
    expect(buildPath("pluginThemeArt", "/control", "@scope/pack", segments)).toBe(pathname);
    expect(parsePath("pluginThemeArt", pathname, "/control")).toEqual({
      ...matched("@scope/pack"),
      segments,
    });
    expect(matchUrl("pluginThemeArt", `${pathname}?v=123`, "/control")).toEqual(
      urlMatch("@scope/pack", "?v=123"),
    );
  });

  it.each(["", "agent/main", "%zz"])("claims malformed workspace icon suffix %j", (suffix) => {
    expect(parsePath("workspaceIcon", `/__openclaw__/workspace-icon/${suffix}`)).toEqual(
      matched(null),
    );
  });

  it("builds cache-busted user avatar paths", () => {
    expect(buildAvatarPath("profile/a b", "hash/image")).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=hash%2Fimage",
    );
    expect(buildAvatarPath("profile/a b", 1_725_000_123_456)).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=1725000123456",
    );
  });

  it.each<[string, string, string | undefined]>([
    ["/api/users/a%2fb/avatar", "/control", "/api/users/a%2fb/avatar"],
    ["/control/api/users/a%2Fb/avatar", "control/", "/api/users/a%2Fb/avatar"],
    ["/control/api/users/%2F/avatar", "/control", "/api/users/%2F/avatar"],
    ["/wilfred/api/users/profile%2F1/avatar", "/wilfred", "/api/users/profile%2F1/avatar"],
    ["/wilfred-other/api/users/profile-1/avatar", "/wilfred", undefined],
    ["/api/users/%zz/avatar", "", undefined],
    ["/api/users//avatar", "", undefined],
    ["/api/users/a/b/avatar", "", undefined],
    ["/api/users/api/users/a/avatar", "/api/users", undefined],
  ])("canonicalizes %s without rewriting encoded IDs", (pathname, base, expected) => {
    expect(canonicalizeAvatar(pathname, base)).toBe(expected);
  });

  it("preserves malformed configured-base user avatar ownership", () => {
    expect(parseAvatar("/wilfred/api/users/p/avatar/extra", "/wilfred")).toEqual(matched(null));
  });

  it.each([
    ["/avatar/main?v=2#profile", "", urlMatch("main", "?v=2", "#profile")],
    ["/control/avatar/main?v=2", "/control", urlMatch("main", "?v=2")],
    ["//evil.example/avatar/main", "", undefined],
    ["//[", "", undefined],
    ["/avatar\\main", "", undefined],
    ["/avatar/main/extra", "", undefined],
    ["/avatar/%zz", "", undefined],
  ] as const)("matches only exact same-origin URL %s", (value, base, expected) => {
    expect(matchUrl("agentAvatar", value, base)).toEqual(expected);
  });
});
