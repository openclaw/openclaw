import { describe, expect, it } from "vitest";
import { loadAllScenarios, filterByTags, filterByMarket, filterByCategory, getScenarioIds, getCategories } from "./_loader.js";

describe("fixture loader", () => {
  const scenarios = loadAllScenarios();

  it("loads at least 56 scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(56);
  });

  it("all IDs are unique", () => {
    const ids = getScenarioIds(scenarios);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all scenarios pass Zod schema validation", () => {
    // If we got here, all scenarios were parsed by loadAllScenarios
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("covers all expected categories", () => {
    const cats = getCategories(scenarios);
    for (const expected of [
      "cn-a-share", "us-equity", "hk-equity", "crypto",
      "risk-control", "cross-market", "approval-flow", "user-journeys",
    ]) {
      expect(cats).toContain(expected);
    }
  });

  it("each category has at least 1 scenario", () => {
    const cats = getCategories(scenarios);
    for (const cat of cats) {
      const filtered = filterByCategory(scenarios, cat);
      expect(filtered.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("filterByTags works", () => {
    const tagged = filterByTags(scenarios, ["normal-trading"]);
    expect(tagged.length).toBeGreaterThanOrEqual(1);
    for (const s of tagged) {
      expect(s.tags).toContain("normal-trading");
    }
  });

  it("filterByMarket works", () => {
    const crypto = filterByMarket(scenarios, "crypto");
    expect(crypto.length).toBeGreaterThanOrEqual(1);
    for (const s of crypto) {
      expect(s.market).toBe("crypto");
    }
  });

  it("cn-a-share has at least 13 scenarios", () => {
    const cn = filterByCategory(scenarios, "cn-a-share");
    expect(cn.length).toBeGreaterThanOrEqual(13);
  });

  it("us-equity has at least 8 scenarios", () => {
    const us = filterByCategory(scenarios, "us-equity");
    expect(us.length).toBeGreaterThanOrEqual(8);
  });

  it("hk-equity has at least 8 scenarios", () => {
    const hk = filterByCategory(scenarios, "hk-equity");
    expect(hk.length).toBeGreaterThanOrEqual(8);
  });

  it("crypto has at least 6 scenarios", () => {
    const cr = filterByCategory(scenarios, "crypto");
    expect(cr.length).toBeGreaterThanOrEqual(6);
  });

  it("risk-control has at least 9 scenarios", () => {
    const rc = filterByCategory(scenarios, "risk-control");
    expect(rc.length).toBeGreaterThanOrEqual(9);
  });
});
