/**
 * CRON_SCHEDULE Gating Tests
 *
 * Tests for the CRON_SCHEDULE execution-boundary gating wrapper.
 * Verifies that cron schedule operations are gated before execution.
 *
 * Tests:
 * 1. PROCEED allows the original cron action unchanged
 * 2. ABSTAIN_CONFIRM blocks before side effect with proper error
 * 3. ABSTAIN_CLARIFY blocks before side effect with proper error
 * 4. Action type and schedule context are captured correctly
 * 5. Execution order: gate → cron side effect (verified via mock call count)
 * 6. Cron action is never called if the gate abstains
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyCronScheduleGateAndAdd,
  applyCronScheduleGateAndUpdate,
  applyCronScheduleGateAndSetEnabled,
} from "../cron-schedule-gating.js";
import { ClarityBurstAbstainError } from "../errors.js";
import * as decisionOverride from "../decision-override.js";

// Mock the decision-override module
vi.mock("../decision-override.js", () => ({
  applyCronScheduleOverrides: vi.fn(),
}));

describe("CRON_SCHEDULE gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("applyCronScheduleGateAndAdd", () => {
    /**
     * Test 1: PROCEED allows original cron action unchanged
     *
     * When gate returns PROCEED, the cron.add function should be called
     * with original parameters and its result returned unmodified.
     */
    it("PROCEED: allows original cron action unchanged", async () => {
      const mockAdd = vi.fn().mockResolvedValueOnce({ id: "job-1", name: "test-job" });
      const jobCreate = { name: "test-job", schedule: { kind: "cron", expr: "0 9 * * *" } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_CREATE",
      });

      const result = await applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create");

      expect(result).toEqual({ id: "job-1", name: "test-job" });
      expect(mockAdd).toHaveBeenCalledWith(jobCreate);
      expect(mockAdd).toHaveBeenCalledTimes(1);
    });

    /**
     * Test 2: ABSTAIN_CONFIRM blocks before side effect
     *
     * When gate returns ABSTAIN_CONFIRM, throw ClarityBurstAbstainError
     * and ensure cron.add is never called.
     */
    it("ABSTAIN_CONFIRM: blocks before side effect", async () => {
      const mockAdd = vi.fn();
      const jobCreate = { name: "restricted-job", schedule: { kind: "cron", expr: "0 9 * * *" } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "CRON_SCHEDULE_CREATE",
        instructions: "User confirmation required",
      });

      await expect(applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create")).rejects.toThrow(
        ClarityBurstAbstainError
      );
      expect(mockAdd).not.toHaveBeenCalled();
    });

    /**
     * Test 3: ABSTAIN_CLARIFY blocks before side effect
     *
     * When gate returns ABSTAIN_CLARIFY, throw ClarityBurstAbstainError
     * and ensure cron.add is never called.
     */
    it("ABSTAIN_CLARIFY: blocks before side effect", async () => {
      const mockAdd = vi.fn();
      const jobCreate = { name: "uncertain-job", schedule: { kind: "every", everyMs: 60000 } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack policy incomplete",
      });

      await expect(applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create")).rejects.toThrow(
        ClarityBurstAbstainError
      );
      expect(mockAdd).not.toHaveBeenCalled();
    });

    /**
     * Test 4: Action type and schedule context captured correctly
     *
     * Verify the context passed to applyCronScheduleOverrides includes
     * correct schedule summary, job name, and action type.
     */
    it("captures action type and schedule context correctly", async () => {
      const mockAdd = vi.fn().mockResolvedValueOnce({ id: "job-2" });
      const jobCreate = {
        name: "reminder",
        schedule: { kind: "cron", expr: "0 9 * * MON-FRI", tz: "America/New_York" },
      };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_CREATE",
      });

      await applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create");

      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      expect(callArgs.stageId).toBe("CRON_SCHEDULE");
      expect(callArgs.schedule).toContain("0 9 * * MON-FRI");
      expect(callArgs.schedule).toContain("America/New_York");
      expect(callArgs.target).toBe("reminder");
      expect(callArgs.taskType).toBe("cron_create");
    });

    /**
     * Test 5: Execution order is gate → cron side effect
     *
     * Use mock call order to verify the gate is called before the cron.add.
     */
    it("execution order: gate → cron side effect", async () => {
      const callOrder: string[] = [];
      const mockAdd = vi.fn().mockImplementation(() => {
        callOrder.push("cron.add");
        return { id: "job-3" };
      });
      const jobCreate = { name: "ordered-job", schedule: { kind: "at", at: "2025-12-25T00:00:00Z" } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockImplementation(async () => {
        callOrder.push("gate");
        return { outcome: "PROCEED", contractId: "CRON_SCHEDULE_CREATE" };
      });

      await applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create");

      expect(callOrder).toEqual(["gate", "cron.add"]);
    });
  });

  describe("applyCronScheduleGateAndUpdate", () => {
    /**
     * Test 6: Update with PROCEED succeeds
     *
     * When gate returns PROCEED for an update, ensure the update is applied.
     */
    it("PROCEED: update succeeds", async () => {
      const mockUpdate = vi.fn().mockResolvedValueOnce({ id: "job-1", enabled: true });
      const patch = { enabled: true };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      const result = await applyCronScheduleGateAndUpdate("job-1", patch, mockUpdate, "update");

      expect(result).toEqual({ id: "job-1", enabled: true });
      expect(mockUpdate).toHaveBeenCalledWith("job-1", patch);
    });

    /**
     * Test 7: ABSTAIN_CONFIRM blocks update before side effect
     */
    it("ABSTAIN_CONFIRM: blocks update before side effect", async () => {
      const mockUpdate = vi.fn();
      const patch = { schedule: { kind: "cron", expr: "0 10 * * *" } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      await expect(applyCronScheduleGateAndUpdate("job-1", patch, mockUpdate, "update")).rejects.toThrow(
        ClarityBurstAbstainError
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    /**
     * Test 8: Enablement context is captured
     *
     * Verify that patch.enabled flag sets taskType to cron_enable/cron_disable.
     */
    it("captures enablement context correctly", async () => {
      const mockUpdate = vi.fn().mockResolvedValueOnce({ id: "job-1" });
      const patch = { enabled: true };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      await applyCronScheduleGateAndUpdate("job-1", patch, mockUpdate, "enable");

      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      expect(callArgs.taskType).toBe("cron_enable");
      expect(callArgs.target).toBe("job-1");
    });

    /**
     * Test 9: Disable detection
     */
    it("detects disable operation", async () => {
      const mockUpdate = vi.fn().mockResolvedValueOnce({ id: "job-1" });
      const patch = { enabled: false };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      await applyCronScheduleGateAndUpdate("job-1", patch, mockUpdate, "disable");

      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      expect(callArgs.taskType).toBe("cron_disable");
    });
  });

  describe("applyCronScheduleGateAndSetEnabled", () => {
    /**
     * Test 10: SetEnabled with true calls gate with enable context
     */
    it("setEnabled(true) uses enable context", async () => {
      const mockUpdate = vi.fn().mockResolvedValueOnce({ id: "job-1", enabled: true });

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      await applyCronScheduleGateAndSetEnabled("job-1", true, mockUpdate);

      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      expect(callArgs.taskType).toBe("cron_enable");
      expect(mockUpdate).toHaveBeenCalledWith("job-1", { enabled: true });
    });

    /**
     * Test 11: SetEnabled with false calls gate with disable context
     */
    it("setEnabled(false) uses disable context", async () => {
      const mockUpdate = vi.fn().mockResolvedValueOnce({ id: "job-1", enabled: false });

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      await applyCronScheduleGateAndSetEnabled("job-1", false, mockUpdate);

      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      expect(callArgs.taskType).toBe("cron_disable");
      expect(mockUpdate).toHaveBeenCalledWith("job-1", { enabled: false });
    });
  });

  describe("Error handling and edge cases", () => {
    /**
     * Test 12: Error propagation (non-abstain errors)
     *
     * If the cron action throws a non-ClarityBurst error, it should propagate.
     */
    it("propagates non-abstain errors from cron action", async () => {
      const mockAdd = vi.fn().mockRejectedValueOnce(new Error("Database connection failed"));
      const jobCreate = { name: "db-error-job", schedule: { kind: "cron", expr: "0 * * * *" } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_CREATE",
      });

      await expect(applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create")).rejects.toThrow(
        "Database connection failed"
      );
    });

    /**
     * Test 13: Schedule extraction with unknown format
     *
     * When schedule format is unknown, should default to "unknown".
     */
    it("handles unknown schedule format gracefully", async () => {
      const mockAdd = vi.fn().mockResolvedValueOnce({ id: "job-4" });
      const jobCreate = { name: "unknown-schedule-job", schedule: { kind: "custom" } };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_CREATE",
      });

      const result = await applyCronScheduleGateAndAdd(jobCreate, mockAdd, "create");

      expect(result).toEqual({ id: "job-4" });
      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      expect(callArgs.schedule).toBe("unknown");
    });

    /**
     * Test 14: Missing schedule in update
     */
    it("handles update with no schedule change", async () => {
      const mockUpdate = vi.fn().mockResolvedValueOnce({ id: "job-1", name: "renamed" });
      const patch = { name: "renamed" };

      vi.mocked(decisionOverride.applyCronScheduleOverrides).mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: "CRON_SCHEDULE_UPDATE",
      });

      const result = await applyCronScheduleGateAndUpdate("job-1", patch, mockUpdate, "update");

      expect(result).toEqual({ id: "job-1", name: "renamed" });
      const callArgs = vi.mocked(decisionOverride.applyCronScheduleOverrides).mock.calls[0][0];
      // When no schedule is provided in patch, scheduleSummary is extracted from undefined,
      // which returns "unknown"
      expect(callArgs.schedule).toBe("unknown");
      expect(callArgs.taskType).toBe("cron_update");
    });
  });
});
