import { afterEach, describe, expect, it, vi } from "vitest";
import { createCostBudgetTracker, type CostBudgetTracker } from "./cost-budget.js";

describe("cost-budget", () => {
  let tracker: CostBudgetTracker;

  afterEach(() => {
    tracker?.dispose();
  });

  describe("under budget", () => {
    it("reports not over budget when spend is below limit", () => {
      tracker = createCostBudgetTracker({
        enabled: true,
        maxDailyCostCents: 500,
      });
      const key = "whatsapp:default:sender1";

      tracker.recordCost(key, 100);
      tracker.recordCost(key, 50);

      const status = tracker.checkBudget(key);
      expect(status.overBudget).toBe(false);
      expect(status.dailySpentCents).toBe(150);
      expect(status.dailyRemainingCents).toBe(350);
    });
  });

  describe("over budget", () => {
    it("reports over budget when daily limit exceeded", () => {
      tracker = createCostBudgetTracker({
        enabled: true,
        maxDailyCostCents: 200,
      });
      const key = "telegram:default:sender2";

      tracker.recordCost(key, 100);
      tracker.recordCost(key, 100);

      const status = tracker.checkBudget(key);
      expect(status.overBudget).toBe(true);
      expect(status.dailySpentCents).toBe(200);
      expect(status.dailyRemainingCents).toBe(0);
    });
  });

  describe("per-message cost cap", () => {
    it("clamps per-message cost to maxPerMessageCostCents", () => {
      tracker = createCostBudgetTracker({
        enabled: true,
        maxDailyCostCents: 1000,
        maxPerMessageCostCents: 50,
      });
      const key = "discord:default:sender3";

      // Record a cost higher than per-message cap
      tracker.recordCost(key, 999);

      const status = tracker.checkBudget(key);
      // Should be clamped to 50
      expect(status.dailySpentCents).toBe(50);
    });
  });

  describe("daily reset", () => {
    it("resets budget when day key changes", () => {
      vi.useFakeTimers();
      try {
        tracker = createCostBudgetTracker({
          enabled: true,
          maxDailyCostCents: 500,
          maxPerMessageCostCents: 500,
          resetHourUtc: 0,
        });
        const key = "slack:default:sender4";

        tracker.recordCost(key, 400);
        expect(tracker.checkBudget(key).dailySpentCents).toBe(400);

        // Advance to the next day
        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

        const status = tracker.checkBudget(key);
        expect(status.dailySpentCents).toBe(0);
        expect(status.overBudget).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("disabled", () => {
    it("returns zero spend and not over budget when disabled", () => {
      tracker = createCostBudgetTracker({ enabled: false });
      const key = "whatsapp:default:sender5";

      tracker.recordCost(key, 9999);

      const status = tracker.checkBudget(key);
      expect(status.overBudget).toBe(false);
      expect(status.dailySpentCents).toBe(0);
    });
  });

  describe("reset", () => {
    it("clears budget for a specific key", () => {
      tracker = createCostBudgetTracker({
        enabled: true,
        maxDailyCostCents: 500,
        maxPerMessageCostCents: 500,
      });
      const key = "signal:default:sender6";

      tracker.recordCost(key, 300);
      expect(tracker.checkBudget(key).dailySpentCents).toBe(300);

      tracker.reset(key);
      expect(tracker.checkBudget(key).dailySpentCents).toBe(0);
    });
  });
});
