import { describe, expect, it } from "vitest";
import {
  buildControlUiResourcePath,
  buildControlUiUserAvatarPath,
  canonicalizeControlUiUserAvatarPath,
  matchControlUiResourceUrl,
  parseControlUiUserAvatarPath,
  parseControlUiResourcePath,
  type ControlUiResourceRoute,
} from "./control-ui-contract.js";

const ROUTES = [
  ["agentAvatar", "ops/main", "/avatar/ops%2Fmain"],
  ["userAvatar", "profile/a b", "/api/users/profile%2Fa%20b/avatar"],
] as const satisfies readonly (readonly [ControlUiResourceRoute, string, string])[];

describe("Control UI resource route contract", () => {
  it.each(ROUTES)("round-trips %s as one encoded segment", (route, value, path) => {
    expect(buildControlUiResourcePath(route, "", value)).toBe(path);
    expect(buildControlUiResourcePath(route, "control/", value)).toBe(`/control${path}`);
    expect(parseControlUiResourcePath(route, path)).toEqual({ matched: true, value });
    expect(parseControlUiResourcePath(route, `/control${path}`, "/control/")).toEqual({
      matched: true,
      value,
    });
  });

  it("round-trips plugin artwork components while preserving scoped plugin IDs", () => {
    const pathname = "/control/__openclaw__/plugin-theme-art/%40scope%2Fpack/neon/hat/beret";
    expect(
      buildControlUiResourcePath("pluginThemeArt", "/control", "@scope/pack", [
        "neon",
        "hat",
        "beret",
      ]),
    ).toBe(pathname);
    expect(parseControlUiResourcePath("pluginThemeArt", pathname, "/control")).toEqual({
      matched: true,
      value: "@scope/pack",
      segments: ["neon", "hat", "beret"],
    });
    expect(matchControlUiResourceUrl("pluginThemeArt", `${pathname}?v=123`, "/control")).toEqual({
      value: "@scope/pack",
      search: "?v=123",
      hash: "",
    });
  });

  it.each([
    ["blank segment", "/__openclaw__/workspace-icon/"],
    ["raw nested segment", "/__openclaw__/workspace-icon/agent/main"],
    ["malformed escape", "/__openclaw__/workspace-icon/%zz"],
  ])("claims a %s without producing a route value", (_label, pathname) => {
    expect(parseControlUiResourcePath("workspaceIcon", pathname)).toEqual({
      matched: true,
      value: null,
    });
  });

  it("builds and canonicalizes cache-busted user avatar paths", () => {
    expect(buildControlUiUserAvatarPath("profile/a b", "hash/image")).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=hash%2Fimage",
    );
    expect(buildControlUiUserAvatarPath("profile/a b", 1_725_000_123_456)).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=1725000123456",
    );
    expect(
      canonicalizeControlUiUserAvatarPath("/wilfred/api/users/profile%2F1/avatar", "/wilfred"),
    ).toBe("/api/users/profile%2F1/avatar");
    expect(
      canonicalizeControlUiUserAvatarPath("/wilfred-other/api/users/profile-1/avatar", "/wilfred"),
    ).toBeUndefined();
  });

  it("preserves malformed configured-base user avatar ownership", () => {
    expect(
      parseControlUiUserAvatarPath("/wilfred/api/users/profile-1/avatar/extra", "/wilfred"),
    ).toEqual({ matched: true, value: null });
  });

  it("matches exact same-origin resource URLs without parser reinterpretation", () => {
    expect(matchControlUiResourceUrl("agentAvatar", "/avatar/main?v=2#profile")).toEqual({
      value: "main",
      search: "?v=2",
      hash: "#profile",
    });
    expect(
      matchControlUiResourceUrl("agentAvatar", "/control/avatar/main?v=2", "/control"),
    ).toEqual({ value: "main", search: "?v=2", hash: "" });
    for (const value of [
      "//evil.example/avatar/main",
      "//[",
      "/avatar\\main",
      "/avatar/main/extra",
      "/avatar/%zz",
    ]) {
      expect(matchControlUiResourceUrl("agentAvatar", value), value).toBeUndefined();
    }
  });
});
