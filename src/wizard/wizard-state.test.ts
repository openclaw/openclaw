import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearWizardState,
  completeWizard,
  createEmptyState,
  getResumeStep,
  hasIncompleteWizard,
  loadWizardState,
  saveWizardState,
  shouldSkipStep,
  updateWizardStep,
  type WizardState,
} from "./wizard-state.js";

describe("wizard-state", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wizard-state-test-"));
    originalEnv = { ...process.env };
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("loadWizardState", () => {
    it("returns null when no state file exists", async () => {
      const state = await loadWizardState(process.env);
      expect(state).toBeNull();
    });

    it("loads existing state from disk", async () => {
      const testState: WizardState = {
        version: 1,
        startedAt: new Date().toISOString(),
        lastCompletedStep: "flow-select",
        completed: false,
        answers: { flow: "quickstart" },
      };
      await fs.writeFile(path.join(tempDir, "wizard-state.json"), JSON.stringify(testState));

      const loaded = await loadWizardState(process.env);
      expect(loaded).toEqual(testState);
    });

    it("returns null for invalid JSON", async () => {
      await fs.writeFile(path.join(tempDir, "wizard-state.json"), "not valid json");

      const state = await loadWizardState(process.env);
      expect(state).toBeNull();
    });

    it("returns null for unknown version", async () => {
      await fs.writeFile(path.join(tempDir, "wizard-state.json"), JSON.stringify({ version: 999 }));

      const state = await loadWizardState(process.env);
      expect(state).toBeNull();
    });
  });

  describe("saveWizardState", () => {
    it("saves state to disk", async () => {
      const testState: WizardState = {
        version: 1,
        startedAt: new Date().toISOString(),
        lastCompletedStep: "auth-choice",
        completed: false,
        answers: { authChoice: "apiKey" },
      };

      await saveWizardState(testState, process.env);

      const raw = await fs.readFile(path.join(tempDir, "wizard-state.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(testState);
    });

    it("creates state directory if it does not exist", async () => {
      const nestedDir = path.join(tempDir, "nested", "state");
      process.env.OPENCLAW_STATE_DIR = nestedDir;

      const testState = createEmptyState();
      await saveWizardState(testState, process.env);

      const exists = await fs
        .stat(path.join(nestedDir, "wizard-state.json"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe("clearWizardState", () => {
    it("removes state file from disk", async () => {
      await fs.writeFile(
        path.join(tempDir, "wizard-state.json"),
        JSON.stringify(createEmptyState()),
      );

      await clearWizardState(process.env);

      const exists = await fs
        .stat(path.join(tempDir, "wizard-state.json"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it("does not throw if file does not exist", async () => {
      await expect(clearWizardState(process.env)).resolves.not.toThrow();
    });
  });

  describe("updateWizardStep", () => {
    it("creates new state if none exists", async () => {
      await updateWizardStep("risk-ack", { riskAccepted: true }, process.env);

      const state = await loadWizardState(process.env);
      expect(state?.lastCompletedStep).toBe("risk-ack");
      expect(state?.answers.riskAccepted).toBe(true);
    });

    it("updates existing state", async () => {
      await updateWizardStep("risk-ack", { riskAccepted: true }, process.env);
      await updateWizardStep("flow-select", { flow: "quickstart" }, process.env);

      const state = await loadWizardState(process.env);
      expect(state?.lastCompletedStep).toBe("flow-select");
      expect(state?.answers.riskAccepted).toBe(true);
      expect(state?.answers.flow).toBe("quickstart");
    });

    it("marks as completed when step is done", async () => {
      await updateWizardStep("done", undefined, process.env);

      const state = await loadWizardState(process.env);
      expect(state?.completed).toBe(true);
    });
  });

  describe("hasIncompleteWizard", () => {
    it("returns false when no state exists", async () => {
      const result = await hasIncompleteWizard(process.env);
      expect(result).toBe(false);
    });

    it("returns true when incomplete state exists", async () => {
      await updateWizardStep("flow-select", { flow: "quickstart" }, process.env);

      const result = await hasIncompleteWizard(process.env);
      expect(result).toBe(true);
    });

    it("returns false when state is completed", async () => {
      await updateWizardStep("done", undefined, process.env);

      const result = await hasIncompleteWizard(process.env);
      expect(result).toBe(false);
    });
  });

  describe("getResumeStep", () => {
    it("returns risk-ack when no step completed", () => {
      const state = createEmptyState();
      expect(getResumeStep(state)).toBe("risk-ack");
    });

    it("returns next step after last completed", () => {
      const state: WizardState = {
        ...createEmptyState(),
        lastCompletedStep: "flow-select",
      };
      expect(getResumeStep(state)).toBe("config-handling");
    });

    it("returns risk-ack for completed wizard", () => {
      const state: WizardState = {
        ...createEmptyState(),
        lastCompletedStep: "done",
        completed: true,
      };
      expect(getResumeStep(state)).toBe("risk-ack");
    });
  });

  describe("shouldSkipStep", () => {
    it("returns false when no state", () => {
      expect(shouldSkipStep("risk-ack", null)).toBe(false);
    });

    it("returns true for steps before lastCompletedStep", () => {
      const state: WizardState = {
        ...createEmptyState(),
        lastCompletedStep: "channels",
      };
      expect(shouldSkipStep("risk-ack", state)).toBe(true);
      expect(shouldSkipStep("flow-select", state)).toBe(true);
      expect(shouldSkipStep("gateway-config", state)).toBe(true);
    });

    it("returns false for steps after lastCompletedStep", () => {
      const state: WizardState = {
        ...createEmptyState(),
        lastCompletedStep: "channels",
      };
      expect(shouldSkipStep("skills", state)).toBe(false);
      expect(shouldSkipStep("hooks", state)).toBe(false);
    });

    it("returns true for the lastCompletedStep itself", () => {
      const state: WizardState = {
        ...createEmptyState(),
        lastCompletedStep: "channels",
      };
      expect(shouldSkipStep("channels", state)).toBe(true);
    });
  });

  describe("completeWizard", () => {
    it("clears state file", async () => {
      await updateWizardStep("channels", undefined, process.env);
      await completeWizard(process.env);

      const state = await loadWizardState(process.env);
      expect(state).toBeNull();
    });
  });
});
