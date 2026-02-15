import { describe, expect, it } from "vitest";
import { expandToolGroups, resolveToolProfilePolicy, TOOL_GROUPS } from "./tool-policy.js";

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("group:fs");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
  });

  describe("plan profile", () => {
    it("resolves plan profile with read-only tools", () => {
      const plan = resolveToolProfilePolicy("plan");
      expect(plan).toBeDefined();
      expect(plan?.allow).toContain("read");
      expect(plan?.allow).toContain("web_search");
      expect(plan?.allow).toContain("web_fetch");
      expect(plan?.allow).toContain("memory_search");
      expect(plan?.allow).toContain("memory_get");
      expect(plan?.allow).toContain("session_status");
      expect(plan?.allow).toContain("sessions_list");
      expect(plan?.allow).toContain("sessions_history");
      expect(plan?.allow).toContain("image");
    });

    it("plan profile does not include write tools", () => {
      const plan = resolveToolProfilePolicy("plan");
      expect(plan?.allow).not.toContain("write");
      expect(plan?.allow).not.toContain("edit");
      expect(plan?.allow).not.toContain("exec");
      expect(plan?.allow).not.toContain("process");
      expect(plan?.allow).not.toContain("message");
      expect(plan?.allow).not.toContain("browser");
      expect(plan?.allow).not.toContain("cron");
      expect(plan?.allow).not.toContain("gateway");
    });
  });
});
