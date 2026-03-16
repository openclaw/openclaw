import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("server.impl OAG integration points", () => {
  const serverImplPath = new URL("./server.impl.ts", import.meta.url).pathname;
  const source = fs.readFileSync(serverImplPath, "utf-8");

  it("imports recordLifecycleShutdown for shutdown snapshot", () => {
    expect(source).toContain("recordLifecycleShutdown");
  });

  it("imports runPostRecoveryAnalysis for startup analysis", () => {
    expect(source).toContain("runPostRecoveryAnalysis");
  });

  it("imports recordOagIncident for incident collection", () => {
    expect(source).toContain("recordOagIncident");
  });

  it("imports checkEvolutionHealth for maintenance timer", () => {
    expect(source).toContain("checkEvolutionHealth");
  });

  it("imports runWhenIdle for idle scheduling", () => {
    expect(source).toContain("runWhenIdle");
  });

  it("imports incrementOagMetric for metrics", () => {
    expect(source).toContain("incrementOagMetric");
  });

  it("imports getOagMetrics for metrics snapshot", () => {
    expect(source).toContain("getOagMetrics");
  });

  it("has evolution check interval cleanup in close", () => {
    expect(source).toContain("evolutionCheckInterval");
  });
});
