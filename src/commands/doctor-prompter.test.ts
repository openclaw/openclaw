import { describe, expect, it } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

const stubRuntime = {} as Parameters<typeof createDoctorPrompter>[0]["runtime"];

describe("createDoctorPrompter", () => {
  describe("confirmDefault (confirm)", () => {
    it("returns true when --repair is passed in non-interactive mode", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { repair: true, nonInteractive: true },
      });
      const result = await prompter.confirm({ message: "repair?" });
      expect(result).toBe(true);
    });

    it("returns false in non-interactive mode without --repair", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { nonInteractive: true },
      });
      const result = await prompter.confirm({ message: "repair?" });
      expect(result).toBe(false);
    });
  });

  describe("confirmRepair", () => {
    it("returns true when --repair is passed in non-interactive mode", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { repair: true, nonInteractive: true },
      });
      const result = await prompter.confirmRepair({ message: "repair?" });
      expect(result).toBe(true);
    });

    it("returns false in non-interactive mode without --repair", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { nonInteractive: true },
      });
      const result = await prompter.confirmRepair({ message: "repair?" });
      expect(result).toBe(false);
    });
  });

  describe("confirmAggressive", () => {
    it("returns true when --repair --force is passed in non-interactive mode", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { repair: true, force: true, nonInteractive: true },
      });
      const result = await prompter.confirmAggressive({ message: "aggressive?" });
      expect(result).toBe(true);
    });

    it("returns false when --repair without --force in non-interactive mode", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { repair: true, nonInteractive: true },
      });
      const result = await prompter.confirmAggressive({ message: "aggressive?" });
      expect(result).toBe(false);
    });

    it("returns false in non-interactive mode without --repair", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { nonInteractive: true },
      });
      const result = await prompter.confirmAggressive({ message: "aggressive?" });
      expect(result).toBe(false);
    });
  });

  describe("confirmSkipInNonInteractive", () => {
    it("returns false in non-interactive mode even with --repair", async () => {
      const prompter = createDoctorPrompter({
        runtime: stubRuntime,
        options: { repair: true, nonInteractive: true },
      });
      const result = await prompter.confirmSkipInNonInteractive({ message: "skip?" });
      expect(result).toBe(false);
    });
  });
});
