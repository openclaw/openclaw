import { describe, expect, it } from "vitest";
import {
  OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES,
  isOpenClawOwnerOnlyCoreToolName,
} from "./owner-only-tools.js";

describe("owner-only core tools", () => {
  it("includes exec in owner-only tool names", () => {
    expect(OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES).toContain("exec");
  });

  it("isOpenClawOwnerOnlyCoreToolName returns true for exec", () => {
    expect(isOpenClawOwnerOnlyCoreToolName("exec")).toBe(true);
  });

  it("isOpenClawOwnerOnlyCoreToolName returns false for non-owner tools", () => {
    expect(isOpenClawOwnerOnlyCoreToolName("web_search")).toBe(false);
    expect(isOpenClawOwnerOnlyCoreToolName("read")).toBe(false);
  });
});
