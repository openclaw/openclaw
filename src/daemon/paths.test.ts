import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".easyhub"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", EASYHUB_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".EasyHub-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", EASYHUB_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".easyhub"));
  });

  it("uses EASYHUB_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", EASYHUB_STATE_DIR: "/var/lib/EasyHub" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/EasyHub"));
  });

  it("expands ~ in EASYHUB_STATE_DIR", () => {
    const env = { HOME: "/Users/test", EASYHUB_STATE_DIR: "~/EasyHub-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/EasyHub-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { EASYHUB_STATE_DIR: "C:\\State\\EasyHub" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\EasyHub");
  });
});
