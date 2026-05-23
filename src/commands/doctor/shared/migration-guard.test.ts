import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasCompletedMigration, stampMigration } from "./migration-guard.js";

function buildCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return { ...overrides } as OpenClawConfig;
}

describe("migration-guard", () => {
  describe("hasCompletedMigration", () => {
    it("returns false when meta is undefined", () => {
      expect(hasCompletedMigration(buildCfg(), "2026.5.0")).toBe(false);
    });

    it("returns false when meta.lastMigrationVersion is missing", () => {
      const cfg = buildCfg({ meta: {} });
      expect(hasCompletedMigration(cfg, "2026.5.0")).toBe(false);
    });

    it("returns false when stamped version is below required", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: "2026.4.0" } as any,
      });
      expect(hasCompletedMigration(cfg, "2026.5.0")).toBe(false);
    });

    it("returns true when stamped version matches required", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: "2026.5.0" } as any,
      });
      expect(hasCompletedMigration(cfg, "2026.5.0")).toBe(true);
    });

    it("returns true when stamped version exceeds required", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: "2026.6.0" } as any,
      });
      expect(hasCompletedMigration(cfg, "2026.5.0")).toBe(true);
    });

    it("handles triple-digit version segments", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: "2026.5.10" } as any,
      });
      expect(hasCompletedMigration(cfg, "2026.5.2")).toBe(true);
    });

    it("returns false for non-string stamped value", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: 123 } as any,
      });
      expect(hasCompletedMigration(cfg, "2026.5.0")).toBe(false);
    });
  });

  describe("stampMigration", () => {
    it("stamps version on empty meta", () => {
      const cfg = buildCfg();
      const result = stampMigration(cfg, "2026.5.0");
      const meta = result.meta as any;
      expect(meta?.lastMigrationVersion).toBe("2026.5.0");
    });

    it("stamps version when current is lower", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: "2026.4.0" } as any,
      });
      const result = stampMigration(cfg, "2026.5.0");
      const meta = result.meta as any;
      expect(meta?.lastMigrationVersion).toBe("2026.5.0");
    });

    it("preserves existing meta properties", () => {
      const cfg = buildCfg({
        meta: { lastTouchedVersion: "2026.5.0" } as any,
      });
      const result = stampMigration(cfg, "2026.5.0");
      const meta = result.meta as any;
      expect(meta?.lastTouchedVersion).toBe("2026.5.0");
      expect(meta?.lastMigrationVersion).toBe("2026.5.0");
    });

    it("does not downgrade when current is higher", () => {
      const cfg = buildCfg({
        meta: { lastMigrationVersion: "2026.6.0" } as any,
      });
      const result = stampMigration(cfg, "2026.5.0");
      const meta = result.meta as any;
      expect(meta?.lastMigrationVersion).toBe("2026.6.0");
    });
  });
});
