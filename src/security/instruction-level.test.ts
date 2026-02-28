import { describe, expect, it } from "vitest";
import { canOverride, isUntrusted, levelLabel, worstCaseLevel } from "./instruction-level.js";
import { InstructionLevel } from "./types.js";

describe("instruction-level", () => {
  describe("canOverride", () => {
    it("SYSTEM can override everything", () => {
      expect(canOverride(InstructionLevel.SYSTEM, InstructionLevel.SYSTEM)).toBe(true);
      expect(canOverride(InstructionLevel.SYSTEM, InstructionLevel.POLICY)).toBe(true);
      expect(canOverride(InstructionLevel.SYSTEM, InstructionLevel.TASK)).toBe(true);
      expect(canOverride(InstructionLevel.SYSTEM, InstructionLevel.USER)).toBe(true);
      expect(canOverride(InstructionLevel.SYSTEM, InstructionLevel.EXTERNAL_CONTENT)).toBe(true);
    });

    it("EXTERNAL_CONTENT can only override itself", () => {
      expect(canOverride(InstructionLevel.EXTERNAL_CONTENT, InstructionLevel.SYSTEM)).toBe(false);
      expect(canOverride(InstructionLevel.EXTERNAL_CONTENT, InstructionLevel.POLICY)).toBe(false);
      expect(canOverride(InstructionLevel.EXTERNAL_CONTENT, InstructionLevel.TASK)).toBe(false);
      expect(canOverride(InstructionLevel.EXTERNAL_CONTENT, InstructionLevel.USER)).toBe(false);
      expect(
        canOverride(InstructionLevel.EXTERNAL_CONTENT, InstructionLevel.EXTERNAL_CONTENT),
      ).toBe(true);
    });

    it("same level can override itself", () => {
      expect(canOverride(InstructionLevel.TASK, InstructionLevel.TASK)).toBe(true);
      expect(canOverride(InstructionLevel.USER, InstructionLevel.USER)).toBe(true);
    });

    it("lower privilege cannot override higher privilege", () => {
      expect(canOverride(InstructionLevel.USER, InstructionLevel.POLICY)).toBe(false);
      expect(canOverride(InstructionLevel.TASK, InstructionLevel.SYSTEM)).toBe(false);
    });
  });

  describe("worstCaseLevel", () => {
    it("returns SYSTEM for empty input", () => {
      expect(worstCaseLevel()).toBe(InstructionLevel.SYSTEM);
    });

    it("returns the single input level", () => {
      expect(worstCaseLevel(InstructionLevel.USER)).toBe(InstructionLevel.USER);
    });

    it("returns least privileged level", () => {
      expect(worstCaseLevel(InstructionLevel.SYSTEM, InstructionLevel.EXTERNAL_CONTENT)).toBe(
        InstructionLevel.EXTERNAL_CONTENT,
      );
    });

    it("handles multiple levels", () => {
      expect(
        worstCaseLevel(InstructionLevel.POLICY, InstructionLevel.TASK, InstructionLevel.USER),
      ).toBe(InstructionLevel.USER);
    });
  });

  describe("isUntrusted", () => {
    it("returns true for EXTERNAL_CONTENT", () => {
      expect(isUntrusted(InstructionLevel.EXTERNAL_CONTENT)).toBe(true);
    });

    it("returns false for all other levels", () => {
      expect(isUntrusted(InstructionLevel.SYSTEM)).toBe(false);
      expect(isUntrusted(InstructionLevel.POLICY)).toBe(false);
      expect(isUntrusted(InstructionLevel.TASK)).toBe(false);
      expect(isUntrusted(InstructionLevel.USER)).toBe(false);
    });
  });

  describe("levelLabel", () => {
    it("returns human-readable labels", () => {
      expect(levelLabel(InstructionLevel.SYSTEM)).toBe("SYSTEM");
      expect(levelLabel(InstructionLevel.POLICY)).toBe("POLICY");
      expect(levelLabel(InstructionLevel.TASK)).toBe("TASK");
      expect(levelLabel(InstructionLevel.USER)).toBe("USER");
      expect(levelLabel(InstructionLevel.EXTERNAL_CONTENT)).toBe("EXTERNAL_CONTENT");
    });

    it("handles unknown levels gracefully", () => {
      expect(levelLabel(99 as InstructionLevel)).toBe("UNKNOWN(99)");
    });
  });
});
