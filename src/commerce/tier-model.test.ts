import { describe, expect, it } from "vitest";
import { resolveTierDefaultModel, shouldUpgradeModel, type PlanTier } from "./tier-model.js";

describe("tier-model", () => {
  describe("resolveTierDefaultModel", () => {
    it("returns zen4.1 for developer tier", () => {
      const ref = resolveTierDefaultModel("developer");
      expect(ref).toEqual({ provider: "hanzo", model: "zen4.1" });
    });

    it("returns zen4-pro for pro tier", () => {
      const ref = resolveTierDefaultModel("pro");
      expect(ref).toEqual({ provider: "hanzo", model: "zen4-pro" });
    });

    it("returns zen4-pro for team tier", () => {
      const ref = resolveTierDefaultModel("team");
      expect(ref).toEqual({ provider: "hanzo", model: "zen4-pro" });
    });

    it("returns zen4-pro for enterprise tier", () => {
      const ref = resolveTierDefaultModel("enterprise");
      expect(ref).toEqual({ provider: "hanzo", model: "zen4-pro" });
    });

    it("falls back to developer for unknown tier", () => {
      const ref = resolveTierDefaultModel("unknown" as PlanTier);
      expect(ref).toEqual({ provider: "hanzo", model: "zen4.1" });
    });
  });

  describe("shouldUpgradeModel", () => {
    it("returns null for developer tier (already on free model)", () => {
      const result = shouldUpgradeModel({
        tier: "developer",
        currentProvider: "hanzo",
        currentModel: "zen4.1",
      });
      expect(result).toBeNull();
    });

    it("upgrades to zen4-pro for pro tier on free-tier default", () => {
      const result = shouldUpgradeModel({
        tier: "pro",
        currentProvider: "hanzo",
        currentModel: "zen4.1",
      });
      expect(result).toEqual({ provider: "hanzo", model: "zen4-pro" });
    });

    it("upgrades to zen4-pro for team tier on free-tier default", () => {
      const result = shouldUpgradeModel({
        tier: "team",
        currentProvider: "hanzo",
        currentModel: "zen4.1",
      });
      expect(result).toEqual({ provider: "hanzo", model: "zen4-pro" });
    });

    it("upgrades to zen4-pro for enterprise tier on free-tier default", () => {
      const result = shouldUpgradeModel({
        tier: "enterprise",
        currentProvider: "hanzo",
        currentModel: "zen4.1",
      });
      expect(result).toEqual({ provider: "hanzo", model: "zen4-pro" });
    });

    it("returns null when user has explicitly set a different model", () => {
      const result = shouldUpgradeModel({
        tier: "pro",
        currentProvider: "hanzo",
        currentModel: "zen4-max",
      });
      expect(result).toBeNull();
    });

    it("returns null when user is on a different provider", () => {
      const result = shouldUpgradeModel({
        tier: "enterprise",
        currentProvider: "anthropic",
        currentModel: "claude-sonnet-4-6",
      });
      expect(result).toBeNull();
    });
  });
});
