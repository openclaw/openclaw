import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".dna"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", DNA_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".dna-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", DNA_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".dna"));
  });

  it("uses DNA_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", DNA_STATE_DIR: "/var/lib/dna" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/dna"));
  });

  it("expands ~ in DNA_STATE_DIR", () => {
    const env = { HOME: "/Users/test", DNA_STATE_DIR: "~/dna-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/dna-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { DNA_STATE_DIR: "C:\\State\\dna" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\dna");
  });
});
