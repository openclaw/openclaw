import { describe, expect, it, vi } from "vitest";
import { repairClaworksLaunchAgentIsolation } from "./claworks-launch-agent-repair.js";

vi.mock("../config/claworks-product-guard.js", () => ({
  detectMisplacedOpenClawLaunchAgent: vi.fn(() => null),
  detectClaworksLaunchAgentPortConflict: vi.fn(() => false),
}));

describe("repairClaworksLaunchAgentIsolation", () => {
  it("returns empty when no conflicts on non-darwin", () => {
    const prior = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = repairClaworksLaunchAgentIsolation({ CLAWORKS_PRODUCT: "1" });
      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain("not macOS");
    } finally {
      Object.defineProperty(process, "platform", { value: prior });
    }
  });

  it("dry-run reports planned changes on darwin", async () => {
    const guard = await import("../config/claworks-product-guard.js");
    vi.mocked(guard.detectMisplacedOpenClawLaunchAgent).mockReturnValue("ai.openclaw.gateway");
    const prior = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const result = repairClaworksLaunchAgentIsolation(
        { CLAWORKS_PRODUCT: "1" },
        { dryRun: true },
      );
      expect(result.changes.some((c) => c.includes("Would remove"))).toBe(true);
      expect(result.changes.some((c) => c.includes("Would reinstall"))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: prior });
      vi.mocked(guard.detectMisplacedOpenClawLaunchAgent).mockReturnValue(null);
    }
  });
});
