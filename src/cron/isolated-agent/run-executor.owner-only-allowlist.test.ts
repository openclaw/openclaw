import { describe, expect, it } from "vitest";
import { resolveCronOwnerOnlyToolAllowlist } from "./run-executor.js";

describe("resolveCronOwnerOnlyToolAllowlist", () => {
  it("returns undefined when toolsAllow is undefined", () => {
    expect(resolveCronOwnerOnlyToolAllowlist(undefined)).toBeUndefined();
  });

  it("returns undefined when toolsAllow is an empty list", () => {
    expect(resolveCronOwnerOnlyToolAllowlist([])).toBeUndefined();
  });

  it("returns undefined when toolsAllow contains no owner-only tools", () => {
    expect(resolveCronOwnerOnlyToolAllowlist(["exec", "read", "write"])).toBeUndefined();
  });

  it("returns only cron-safe owner-only tools from a mixed list", () => {
    expect(resolveCronOwnerOnlyToolAllowlist(["exec", "cron", "nodes"])).toEqual(["cron"]);
  });

  it("returns undefined when toolsAllow contains only non-cron-safe owner-only tools", () => {
    expect(resolveCronOwnerOnlyToolAllowlist(["gateway", "nodes"])).toBeUndefined();
  });

  it("returns a single owner-only tool", () => {
    expect(resolveCronOwnerOnlyToolAllowlist(["cron"])).toEqual(["cron"]);
  });
});
