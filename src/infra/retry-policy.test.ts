/**
 * Tests for Failure Economics - Retry Policy module
 *
 * @module infra/retry-policy.test
 */

import { describe, expect, it, vi } from "vitest";
import {
  ErrorTaxonomy,
  ErrorSeverity,
  EscalationReason,
  EscalationAction,
  SchemaViolationError,
  ModelFailureError,
  ToolFailureError,
  ResourceExhaustionError,
  InvariantViolationError,
  ContextOverflowError,
  TimeoutError,
} from "../contracts/error-taxonomy.js";
import {
  RetryPolicyEnforcer,
  createRetryPolicyEnforcer,
  DEFAULT_RETRY_POLICY,
  shouldRetry,
  executeWithRetry,
  type FailureRecord,
} from "./retry-policy.js";

describe("Retry Policy (D8-D9)", () => {
  describe("DEFAULT_RETRY_POLICY", () => {
    it("enforces max 1 retry", () => {
      expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(1);
    });

    it("requires changed input", () => {
      expect(DEFAULT_RETRY_POLICY.requireChangedInput).toBe(true);
    });

    it("tracks failure history", () => {
      expect(DEFAULT_RETRY_POLICY.trackFailureHistory).toBe(true);
    });
  });

  describe("RetryPolicyEnforcer", () => {
    describe("D8: Max 1 Retry Policy", () => {
      it("allows retry on first failure with changed input", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Schema failed", { schemaName: "Test" });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("retry");
        if (outcome.decision === "retry") {
          expect(outcome.strategy.attempt).toBe(1);
          expect(outcome.strategy.requiresChangedInput).toBe(true);
        }
      });

      it("denies retry without changed input when required", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Schema failed", { schemaName: "Test" });

        const outcome = enforcer.evaluate(error, false);

        expect(outcome.decision).toBe("fail");
        if (outcome.decision === "fail") {
          expect(outcome.error).toContain("requires changed input");
        }
      });

      it("allows retry without changed input for tool failures", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new ToolFailureError("Tool failed", { toolName: "shell" });

        const outcome = enforcer.evaluate(error, false);

        expect(outcome.decision).toBe("retry");
      });

      it("escalates after max retries exceeded", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error1 = new SchemaViolationError("Schema failed", { schemaName: "Test" });
        const error2 = new SchemaViolationError("Schema failed again", { schemaName: "Test" });

        // First failure - retry allowed
        enforcer.evaluate(error1, true);

        // Second failure - should escalate (max 1 retry)
        const outcome = enforcer.evaluate(error2, true);

        expect(outcome.decision).toBe("escalate");
        if (outcome.decision === "escalate") {
          expect(outcome.reason).toBe(EscalationReason.REPEATED_FAILURE);
        }
      });

      it("does not retry non-retryable errors", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new InvariantViolationError("Invariant breached", {
          invariant: "test",
        });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("escalate");
        if (outcome.decision === "escalate") {
          expect(outcome.reason).toBe(EscalationReason.INVARIANT_VIOLATION);
          expect(outcome.action).toBe(EscalationAction.ABORT);
        }
      });
    });

    describe("D9: Same Failure Twice → Escalate", () => {
      it("escalates when same schema error occurs twice", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Same schema issue", { schemaName: "Test" });

        // First occurrence
        enforcer.evaluate(error, true);

        // Second occurrence - same message
        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("escalate");
        if (outcome.decision === "escalate") {
          expect(outcome.reason).toBe(EscalationReason.REPEATED_FAILURE);
        }
      });

      it("does not escalate for different error messages", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error1 = new SchemaViolationError("First issue", { schemaName: "Test" });
        const error2 = new SchemaViolationError("Different issue", { schemaName: "Test" });

        enforcer.evaluate(error1, true);
        const outcome = enforcer.evaluate(error2, true);

        expect(outcome.decision).toBe("retry");
      });

      it("escalates model failures with same message", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new ModelFailureError("Model refused", { failureType: "refusal" });

        enforcer.evaluate(error, true);
        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("escalate");
      });

      it("escalates resource exhaustion immediately", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new ResourceExhaustionError("Out of tokens", { resourceType: "tokens" });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("escalate");
        if (outcome.decision === "escalate") {
          expect(outcome.reason).toBe(EscalationReason.BUDGET_EXCEEDED);
        }
      });

      it("escalates invariant violations immediately", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new InvariantViolationError("Dispatcher bypass", {
          invariant: "dispatcher_supremacy",
        });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("escalate");
        if (outcome.decision === "escalate") {
          expect(outcome.reason).toBe(EscalationReason.INVARIANT_VIOLATION);
          expect(outcome.action).toBe(EscalationAction.ABORT);
        }
      });
    });

    describe("Retry Strategy Building", () => {
      it("suggests compact context for schema violations", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Schema failed", { schemaName: "Test" });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("retry");
        if (outcome.decision === "retry") {
          expect(outcome.strategy.suggestedChanges?.compactContext).toBe(true);
        }
      });

      it("suggests model change for model failures", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new ModelFailureError("Model failed", { failureType: "error" });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("retry");
        if (outcome.decision === "retry") {
          expect(outcome.strategy.suggestedChanges?.changeModel).toBe(true);
        }
      });

      it("suggests budget reduction for context overflow", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new ContextOverflowError("Too big", { currentTokens: 200000 });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("retry");
        if (outcome.decision === "retry") {
          expect(outcome.strategy.suggestedChanges?.compactContext).toBe(true);
          expect(outcome.strategy.suggestedChanges?.reduceContextBudget).toBe(true);
        }
      });

      it("suggests timeout increase for timeout errors", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new TimeoutError("Timed out", { timeoutMs: 30000 });

        const outcome = enforcer.evaluate(error, true);

        expect(outcome.decision).toBe("retry");
        if (outcome.decision === "retry") {
          expect(outcome.strategy.timeoutMs).toBe(60000);
        }
      });
    });

    describe("Failure History", () => {
      it("records failures in history", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Schema failed", { schemaName: "Test" });

        enforcer.recordFailure(error);

        const history = enforcer.getFailureHistory();
        expect(history).toHaveLength(1);
        expect(history[0].taxonomy).toBe(ErrorTaxonomy.SCHEMA_VIOLATION);
        expect(history[0].message).toBe("Schema failed");
      });

      it("gets relevant history for same error type", () => {
        const enforcer = new RetryPolicyEnforcer();
        const schemaError = new SchemaViolationError("Schema issue", {});
        const modelError = new ModelFailureError("Model issue", { failureType: "error" });

        enforcer.recordFailure(schemaError);
        enforcer.recordFailure(modelError);

        const relevant = enforcer.getRelevantHistory(schemaError);
        expect(relevant).toHaveLength(1);
        expect(relevant[0].taxonomy).toBe(ErrorTaxonomy.SCHEMA_VIOLATION);
      });

      it("tracks attempt count correctly", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Schema failed", {});

        expect(enforcer.getCurrentAttempt()).toBe(0);

        enforcer.evaluate(error, true);
        expect(enforcer.getCurrentAttempt()).toBe(1);

        // This should escalate since we've hit max retries
        enforcer.evaluate(error, true);
        expect(enforcer.getCurrentAttempt()).toBe(1); // No increment on escalation
      });

      it("resets state correctly", () => {
        const enforcer = new RetryPolicyEnforcer();
        const error = new SchemaViolationError("Schema failed", {});

        enforcer.evaluate(error, true);
        expect(enforcer.getFailureHistory()).toHaveLength(1);
        expect(enforcer.getCurrentAttempt()).toBe(1);

        enforcer.reset();

        expect(enforcer.getFailureHistory()).toHaveLength(0);
        expect(enforcer.getCurrentAttempt()).toBe(0);
      });

      it("does not track history when disabled", () => {
        const enforcer = new RetryPolicyEnforcer({ trackFailureHistory: false });
        const error = new SchemaViolationError("Schema failed", {});

        enforcer.recordFailure(error);

        expect(enforcer.getFailureHistory()).toHaveLength(0);
      });
    });

    describe("Unknown Errors", () => {
      it("fails for non-OpenClawError", () => {
        const enforcer = new RetryPolicyEnforcer();

        const outcome = enforcer.evaluate(new Error("Regular error"), true);

        expect(outcome.decision).toBe("fail");
        if (outcome.decision === "fail") {
          expect(outcome.error).toContain("Unknown error type");
        }
      });

      it("fails for string errors", () => {
        const enforcer = new RetryPolicyEnforcer();

        const outcome = enforcer.evaluate("string error", true);

        expect(outcome.decision).toBe("fail");
      });

      it("fails for null", () => {
        const enforcer = new RetryPolicyEnforcer();

        const outcome = enforcer.evaluate(null, true);

        expect(outcome.decision).toBe("fail");
      });
    });
  });

  describe("createRetryPolicyEnforcer", () => {
    it("creates with default config", () => {
      const enforcer = createRetryPolicyEnforcer();
      expect(enforcer).toBeInstanceOf(RetryPolicyEnforcer);
    });

    it("creates with custom config", () => {
      const enforcer = createRetryPolicyEnforcer({ maxRetries: 2 });
      // Should still have custom config applied
      expect(enforcer).toBeInstanceOf(RetryPolicyEnforcer);
    });
  });

  describe("shouldRetry", () => {
    it("returns true when retryable", () => {
      const error = new SchemaViolationError("Test", {});
      expect(shouldRetry(error, 0, true)).toBe(true);
    });

    it("returns false when max retries exceeded", () => {
      const error = new SchemaViolationError("Test", {});
      expect(shouldRetry(error, 1, true)).toBe(false);
    });

    it("returns false for non-OpenClawError", () => {
      expect(shouldRetry(new Error("Test"), 0, true)).toBe(false);
    });

    it("returns false when requiresChangedInput not met", () => {
      const error = new SchemaViolationError("Test", {});
      expect(shouldRetry(error, 0, false)).toBe(false);
    });
  });

  describe("executeWithRetry", () => {
    it("returns result on success", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      const result = await executeWithRetry({
        operation,
        hasChangedInput: () => true,
      });

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new SchemaViolationError("Fail", {}))
        .mockResolvedValueOnce("success");

      const result = await executeWithRetry({
        operation,
        hasChangedInput: () => true,
      });

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("escalates on repeated failure", async () => {
      const error = new SchemaViolationError("Same error", {});
      const operation = vi.fn().mockRejectedValue(error);
      const onEscalate = vi.fn();

      const result = await executeWithRetry({
        operation,
        hasChangedInput: () => true,
        onEscalate,
      });

      expect(result).toBeNull();
      expect(onEscalate).toHaveBeenCalledWith(
        EscalationReason.REPEATED_FAILURE,
        EscalationAction.RETRY_WITH_COMPACTION,
        expect.objectContaining({
          taxonomy: ErrorTaxonomy.SCHEMA_VIOLATION,
        }),
      );
    });

    it("calls onFail when retry requires changed input", async () => {
      const error = new SchemaViolationError("Fail", {});
      const operation = vi.fn().mockRejectedValue(error);
      const onFail = vi.fn();

      const result = await executeWithRetry({
        operation,
        hasChangedInput: () => false,
        onFail,
      });

      expect(result).toBeNull();
      expect(onFail).toHaveBeenCalledWith(expect.stringContaining("requires changed input"));
    });

    it("calls changeInput when retrying", async () => {
      const error = new SchemaViolationError("Fail", {});
      const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("success");
      const changeInput = vi.fn();

      await executeWithRetry({
        operation,
        hasChangedInput: () => true,
        changeInput,
      });

      expect(changeInput).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          requiresChangedInput: true,
        }),
      );
    });

    it("handles unknown errors by failing", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("Unknown"));
      const onFail = vi.fn();

      const result = await executeWithRetry({
        operation,
        hasChangedInput: () => true,
        onFail,
      });

      expect(result).toBeNull();
      expect(onFail).toHaveBeenCalled();
    });
  });
});
