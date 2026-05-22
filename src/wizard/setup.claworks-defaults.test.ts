import { describe, expect, it } from "vitest";
import { mergeClaworksProductDefaults } from "./setup.claworks-defaults.js";

describe("mergeClaworksProductDefaults", () => {
  it("no-ops outside ClaWorks product mode", () => {
    const cfg = { gateway: { port: 18789 } };
    expect(mergeClaworksProductDefaults(cfg, {})).toEqual(cfg);
  });

  it("merges extended plugin allow and default port", () => {
    const next = mergeClaworksProductDefaults(
      { plugins: { allow: ["claworks-robot"], entries: {} } },
      { CLAWORKS_PRODUCT: "1", OPENCLAW_STATE_DIR: "/tmp/claworks-test" },
    );
    expect(next.plugins?.allow).toContain("feishu");
    expect(next.plugins?.allow).toContain("openai");
    expect(next.plugins?.entries?.["claworks-robot"]?.enabled).toBe(true);
    expect(next.plugins?.entries?.feishu?.enabled).toBe(true);
    expect(next.gateway?.port).toBe(18800);
    expect(next.agents?.defaults?.workspace).toBe("/tmp/claworks-test/workspace");
  });
});
