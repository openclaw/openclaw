import { describe, expect, it } from "vitest";
import { resolveProbeBudgetMs } from "./helpers.js";

describe("resolveProbeBudgetMs", () => {
  it("lets local loopback use the full requested timeout", () => {
    expect(resolveProbeBudgetMs(3000, "localLoopback")).toBe(3000);
    expect(resolveProbeBudgetMs(10000, "localLoopback")).toBe(10000);
  });

  it("keeps ssh tunnel capped", () => {
    expect(resolveProbeBudgetMs(3000, "sshTunnel")).toBe(2000);
    expect(resolveProbeBudgetMs(1500, "sshTunnel")).toBe(1500);
  });

  it("keeps discovered targets capped", () => {
    expect(resolveProbeBudgetMs(3000, "bonjourLanHost")).toBe(1500);
    expect(resolveProbeBudgetMs(1200, "configuredUrl")).toBe(1200);
  });
});
