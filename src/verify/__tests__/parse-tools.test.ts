import * as path from "path";
import { describe, it, expect } from "vitest";
import { parsePipeline } from "../parse-pipeline.js";
import { parsePolicies } from "../parse-policies.js";
import { parseToolCatalog } from "../parse-tools.js";

const srcDir = path.resolve(import.meta.dirname ?? __dirname, "../../..");

describe("parseToolCatalog", () => {
  const catalog = parseToolCatalog(path.join(srcDir, "src"));

  it("parses all 25 tool definitions", () => {
    expect(catalog.tools.length).toBe(25);
  });

  it("extracts tool ids correctly", () => {
    const ids = catalog.tools.map((t) => t.id);
    expect(ids).toContain("read");
    expect(ids).toContain("exec");
    expect(ids).toContain("browser");
    expect(ids).toContain("tts");
  });

  it("extracts section ids", () => {
    const tool = catalog.tools.find((t) => t.id === "read");
    expect(tool?.sectionId).toBe("fs");
  });

  it("extracts profiles", () => {
    const tool = catalog.tools.find((t) => t.id === "exec");
    expect(tool?.profiles).toEqual(["coding"]);
  });

  it("extracts includeInOpenClawGroup", () => {
    const read = catalog.tools.find((t) => t.id === "read");
    expect(read?.includeInOpenClawGroup).toBe(false);
    const browser = catalog.tools.find((t) => t.id === "browser");
    expect(browser?.includeInOpenClawGroup).toBe(true);
  });

  it("parses section order", () => {
    expect(catalog.sectionOrder.length).toBeGreaterThan(0);
    expect(catalog.sectionOrder[0].id).toBe("fs");
  });
});

describe("parsePolicies", () => {
  const policies = parsePolicies(path.join(srcDir, "src"));

  it("parses aliases", () => {
    expect(policies.aliases).toEqual({
      bash: "exec",
      "apply-patch": "apply_patch",
    });
  });

  it("parses owner-only fallbacks", () => {
    expect(policies.ownerOnlyFallbacks).toContain("gateway");
    expect(policies.ownerOnlyFallbacks).toContain("cron");
    expect(policies.ownerOnlyFallbacks).toContain("whatsapp_login");
  });

  it("parses subagent deny always list", () => {
    expect(policies.subagentDenyAlways).toContain("gateway");
    expect(policies.subagentDenyAlways).toContain("session_status");
    expect(policies.subagentDenyAlways).toContain("sessions_send");
  });

  it("parses subagent deny leaf list", () => {
    expect(policies.subagentDenyLeaf).toContain("sessions_spawn");
    expect(policies.subagentDenyLeaf).toContain("sessions_list");
  });
});

describe("parsePipeline", () => {
  const pipeline = parsePipeline(path.join(srcDir, "src"));

  it("parses 7 pipeline steps", () => {
    expect(pipeline.steps.length).toBe(7);
  });

  it("all steps have stripPluginOnlyAllowlist", () => {
    for (const step of pipeline.steps) {
      expect(step.stripPluginOnlyAllowlist).toBe(true);
    }
  });
});
