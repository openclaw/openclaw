/**
 * Tests for Failure Economics - Error Taxonomy module
 *
 * @module contracts/error-taxonomy.test
 */

import { describe, expect, it } from "vitest";
import {
  ErrorTaxonomy,
  ErrorSeverity,
  EscalationReason,
  EscalationAction,
  OpenClawError,
  SchemaViolationError,
  ModelFailureError,
  ToolFailureError,
  ResourceExhaustionError,
  InvariantViolationError,
  ContextOverflowError,
  TimeoutError,
  AbortError,
  ERROR_RESPONSE_MAP,
  getErrorResponseConfig,
  isRetryable,
  shouldEscalate,
  isOpenClawError,
  isErrorTaxonomy,
  getErrorTaxonomy,
} from "./error-taxonomy.js";

describe("Error Taxonomy", () => {
  describe("D1: Error Taxonomy Constants", () => {
    it("has all expected error taxonomy values", () => {
      expect(ErrorTaxonomy.SCHEMA_VIOLATION).toBe("schema_violation");
      expect(ErrorTaxonomy.MODEL_FAILURE).toBe("model_failure");
      expect(ErrorTaxonomy.TOOL_FAILURE).toBe("tool_failure");
      expect(ErrorTaxonomy.RESOURCE_EXHAUSTION).toBe("resource_exhaustion");
      expect(ErrorTaxonomy.INVARIANT_VIOLATION).toBe("invariant_violation");
      expect(ErrorTaxonomy.CONTEXT_OVERFLOW).toBe("context_overflow");
      expect(ErrorTaxonomy.TIMEOUT).toBe("timeout");
      expect(ErrorTaxonomy.ABORT).toBe("abort");
      expect(ErrorTaxonomy.UNKNOWN).toBe("unknown");
    });

    it("has all expected escalation reasons", () => {
      expect(EscalationReason.REPEATED_FAILURE).toBe("repeated_failure");
      expect(EscalationReason.CONTEXT_OVERFLOW).toBe("context_overflow");
      expect(EscalationReason.MODEL_REFUSAL).toBe("model_refusal");
      expect(EscalationReason.BUDGET_EXCEEDED).toBe("budget_exceeded");
      expect(EscalationReason.INVARIANT_VIOLATION).toBe("invariant_violation");
      expect(EscalationReason.TOOL_UNAVAILABLE).toBe("tool_unavailable");
      expect(EscalationReason.USER_REQUESTED).toBe("user_requested");
    });

    it("has all expected escalation actions", () => {
      expect(EscalationAction.RETRY_DIFFERENT_MODEL).toBe("retry_different_model");
      expect(EscalationAction.RETRY_WITH_COMPACTION).toBe("retry_with_compaction");
      expect(EscalationAction.ABORT).toBe("abort");
      expect(EscalationAction.ASK_USER).toBe("ask_user");
      expect(EscalationAction.FALLBACK).toBe("fallback");
    });

    it("has all expected severity levels", () => {
      expect(ErrorSeverity.LOW).toBe("low");
      expect(ErrorSeverity.MEDIUM).toBe("medium");
      expect(ErrorSeverity.HIGH).toBe("high");
      expect(ErrorSeverity.CRITICAL).toBe("critical");
    });
  });

  describe("D2: SchemaViolationError", () => {
    it("creates error with correct taxonomy", () => {
      const err = new SchemaViolationError("Schema validation failed", {
        schemaName: "PlanRequest",
        validationErrors: ["Missing required field 'requestId'"],
      });

      expect(err.taxonomy).toBe(ErrorTaxonomy.SCHEMA_VIOLATION);
      expect(err.severity).toBe(ErrorSeverity.MEDIUM);
      expect(err.retryable).toBe(true);
      expect(err.requiresChangedInput).toBe(true);
      expect(err.suggestedAction).toBe(EscalationAction.RETRY_WITH_COMPACTION);
      expect(err.schemaName).toBe("PlanRequest");
      expect(err.validationErrors).toEqual(["Missing required field 'requestId'"]);
    });

    it("serializes to JSON correctly", () => {
      const err = new SchemaViolationError("Schema validation failed", {
        schemaName: "PlanRequest",
      });

      const json = err.toJSON();
      expect(json.taxonomy).toBe(ErrorTaxonomy.SCHEMA_VIOLATION);
      expect(json.severity).toBe(ErrorSeverity.MEDIUM);
      expect(json.message).toBe("Schema validation failed");
      expect(json.retryable).toBe(true);
      expect(json.suggestedAction).toBe(EscalationAction.RETRY_WITH_COMPACTION);
      expect(json.timestamp).toBeTypeOf("number");
    });
  });

  describe("D3: ModelFailureError", () => {
    it("creates error with correct taxonomy", () => {
      const err = new ModelFailureError("Model returned error", {
        failureType: "refusal",
        modelId: "claude-3-opus",
        provider: "anthropic",
      });

      expect(err.taxonomy).toBe(ErrorTaxonomy.MODEL_FAILURE);
      expect(err.severity).toBe(ErrorSeverity.MEDIUM);
      expect(err.retryable).toBe(true);
      expect(err.requiresChangedInput).toBe(true);
      expect(err.suggestedAction).toBe(EscalationAction.RETRY_DIFFERENT_MODEL);
      expect(err.failureType).toBe("refusal");
      expect(err.modelId).toBe("claude-3-opus");
      expect(err.provider).toBe("anthropic");
    });

    it("handles all failure types", () => {
      const types: Array<"error" | "refusal" | "invalid_output" | "hallucination"> = [
        "error",
        "refusal",
        "invalid_output",
        "hallucination",
      ];

      for (const failureType of types) {
        const err = new ModelFailureError("Model failed", { failureType });
        expect(err.failureType).toBe(failureType);
      }
    });
  });

  describe("D4: ToolFailureError", () => {
    it("creates error with correct taxonomy", () => {
      const err = new ToolFailureError("Command failed", {
        toolName: "shell",
        exitCode: 1,
        stderr: "Permission denied",
      });

      expect(err.taxonomy).toBe(ErrorTaxonomy.TOOL_FAILURE);
      expect(err.severity).toBe(ErrorSeverity.MEDIUM);
      expect(err.retryable).toBe(true);
      expect(err.requiresChangedInput).toBe(false); // Tool failures can retry same input
      expect(err.suggestedAction).toBe(EscalationAction.RETRY_WITH_COMPACTION);
      expect(err.toolName).toBe("shell");
      expect(err.exitCode).toBe(1);
      expect(err.stderr).toBe("Permission denied");
    });
  });

  describe("D5: ResourceExhaustionError", () => {
    it("creates error with correct taxonomy", () => {
      const err = new ResourceExhaustionError("Token limit exceeded", {
        resourceType: "tokens",
        currentUsage: 100000,
        maximumAllowed: 80000,
      });

      expect(err.taxonomy).toBe(ErrorTaxonomy.RESOURCE_EXHAUSTION);
      expect(err.severity).toBe(ErrorSeverity.HIGH);
      expect(err.retryable).toBe(false);
      expect(err.requiresChangedInput).toBe(true);
      expect(err.suggestedAction).toBe(EscalationAction.RETRY_WITH_COMPACTION);
      expect(err.resourceType).toBe("tokens");
      expect(err.currentUsage).toBe(100000);
      expect(err.maximumAllowed).toBe(80000);
    });

    it("handles all resource types", () => {
      const types: Array<"tokens" | "rate_limit" | "memory" | "disk" | "quota" | "other"> = [
        "tokens",
        "rate_limit",
        "memory",
        "disk",
        "quota",
        "other",
      ];

      for (const resourceType of types) {
        const err = new ResourceExhaustionError("Resource exhausted", { resourceType });
        expect(err.resourceType).toBe(resourceType);
      }
    });
  });

  describe("D6: InvariantViolationError", () => {
    it("creates error with correct taxonomy", () => {
      const err = new InvariantViolationError("Only dispatcher can route tasks", {
        invariant: "dispatcher_supremacy",
        violator: "executor",
      });

      expect(err.taxonomy).toBe(ErrorTaxonomy.INVARIANT_VIOLATION);
      expect(err.severity).toBe(ErrorSeverity.CRITICAL);
      expect(err.retryable).toBe(false);
      expect(err.requiresChangedInput).toBe(false);
      expect(err.suggestedAction).toBe(EscalationAction.ABORT);
      expect(err.invariant).toBe("dispatcher_supremacy");
      expect(err.violator).toBe("executor");
    });
  });

  describe("Additional Error Classes", () => {
    it("ContextOverflowError has correct configuration", () => {
      const err = new ContextOverflowError("Context too large", {
        currentTokens: 200000,
        maxTokens: 180000,
      });

      expect(err.taxonomy).toBe(ErrorTaxonomy.CONTEXT_OVERFLOW);
      expect(err.severity).toBe(ErrorSeverity.HIGH);
      expect(err.retryable).toBe(true);
      expect(err.currentTokens).toBe(200000);
      expect(err.maxTokens).toBe(180000);
    });

    it("TimeoutError has correct configuration", () => {
      const err = new TimeoutError("Request timed out", { timeoutMs: 30000 });

      expect(err.taxonomy).toBe(ErrorTaxonomy.TIMEOUT);
      expect(err.severity).toBe(ErrorSeverity.MEDIUM);
      expect(err.retryable).toBe(true);
      expect(err.timeoutMs).toBe(30000);
    });

    it("AbortError has correct configuration", () => {
      const err = new AbortError("Operation cancelled", { abortReason: "user_request" });

      expect(err.taxonomy).toBe(ErrorTaxonomy.ABORT);
      expect(err.severity).toBe(ErrorSeverity.LOW);
      expect(err.retryable).toBe(false);
      expect(err.abortReason).toBe("user_request");
    });
  });

  describe("D7: Error-to-Response Mapping", () => {
    it("has response config for all taxonomy types", () => {
      for (const taxonomy of Object.values(ErrorTaxonomy)) {
        const config = getErrorResponseConfig(taxonomy);
        expect(config).toBeDefined();
        expect(config.retryable).toBeTypeOf("boolean");
        expect(config.maxRetries).toBeTypeOf("number");
        expect(config.requiresChangedInput).toBeTypeOf("boolean");
        expect(config.suggestedAction).toBeTypeOf("string");
        expect(config.escalateOnRepeat).toBeTypeOf("boolean");
        expect(config.severity).toBeTypeOf("string");
        expect(config.userMessage).toBeTypeOf("string");
      }
    });

    it("returns UNKNOWN config for invalid taxonomy", () => {
      const config = getErrorResponseConfig("invalid" as ErrorTaxonomy);
      expect(config.severity).toBe(ErrorSeverity.HIGH);
      expect(config.retryable).toBe(false);
    });

    it("enforces max 1 retry for all retryable errors", () => {
      for (const [taxonomy, config] of Object.entries(ERROR_RESPONSE_MAP)) {
        if (config.retryable) {
          expect(config.maxRetries, `${taxonomy} should have maxRetries <= 1`).toBeLessThanOrEqual(
            1,
          );
        }
      }
    });
  });

  describe("D8: Max 1 Retry Policy", () => {
    it("allows retry when under max attempts", () => {
      const result = isRetryable(ErrorTaxonomy.SCHEMA_VIOLATION, 0, true);
      expect(result).toBe(true);
    });

    it("denies retry when max attempts exceeded", () => {
      const result = isRetryable(ErrorTaxonomy.SCHEMA_VIOLATION, 1, true);
      expect(result).toBe(false); // maxRetries is 1, so attempt 1 means we've already retried
    });

    it("denies retry when requiresChangedInput and input unchanged", () => {
      const result = isRetryable(ErrorTaxonomy.SCHEMA_VIOLATION, 0, false);
      expect(result).toBe(false);
    });

    it("allows retry for tool failures without input change", () => {
      const result = isRetryable(ErrorTaxonomy.TOOL_FAILURE, 0, false);
      expect(result).toBe(true);
    });

    it("denies retry for non-retryable errors", () => {
      const result = isRetryable(ErrorTaxonomy.INVARIANT_VIOLATION, 0, true);
      expect(result).toBe(false);
    });

    it("works with OpenClawError instances", () => {
      const err = new SchemaViolationError("Test", { schemaName: "Test" });
      expect(isRetryable(err, 0, true)).toBe(true);
      expect(isRetryable(err, 1, true)).toBe(false);
    });
  });

  describe("D9: Same Failure Twice → Escalate", () => {
    it("escalates when same failure occurs twice", () => {
      const firstError = new SchemaViolationError("Schema failed", { schemaName: "Test" });
      const secondError = new SchemaViolationError("Schema failed", { schemaName: "Test" });

      const result = shouldEscalate(secondError, [firstError]);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toBe(EscalationReason.REPEATED_FAILURE);
      expect(result.action).toBe(EscalationAction.RETRY_WITH_COMPACTION);
    });

    it("does not escalate on first failure", () => {
      const error = new SchemaViolationError("Schema failed", { schemaName: "Test" });

      const result = shouldEscalate(error, []);

      expect(result.shouldEscalate).toBe(false);
    });

    it("does not escalate for different error messages", () => {
      const firstError = new SchemaViolationError("First issue", { schemaName: "Test" });
      const secondError = new SchemaViolationError("Different issue", { schemaName: "Test" });

      const result = shouldEscalate(secondError, [firstError]);

      expect(result.shouldEscalate).toBe(false);
    });

    it("escalates invariant violations immediately", () => {
      const error = new InvariantViolationError("Invariant breached", {
        invariant: "test",
      });

      const result = shouldEscalate(error, []);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toBe(EscalationReason.INVARIANT_VIOLATION);
      expect(result.action).toBe(EscalationAction.ABORT);
    });

    it("escalates resource exhaustion immediately", () => {
      const error = new ResourceExhaustionError("Out of tokens", { resourceType: "tokens" });

      const result = shouldEscalate(error, []);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toBe(EscalationReason.BUDGET_EXCEEDED);
    });

    it("escalates context overflow immediately", () => {
      const error = new ContextOverflowError("Too much context", {});

      const result = shouldEscalate(error, []);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toBe(EscalationReason.CONTEXT_OVERFLOW);
    });
  });

  describe("Type Guards", () => {
    it("isOpenClawError returns true for OpenClawError instances", () => {
      const err = new SchemaViolationError("Test", {});
      expect(isOpenClawError(err)).toBe(true);
      expect(isOpenClawError(new Error("Regular error"))).toBe(false);
      expect(isOpenClawError("string")).toBe(false);
      expect(isOpenClawError(null)).toBe(false);
    });

    it("isErrorTaxonomy checks taxonomy correctly", () => {
      const err = new SchemaViolationError("Test", {});
      expect(isErrorTaxonomy(err, ErrorTaxonomy.SCHEMA_VIOLATION)).toBe(true);
      expect(isErrorTaxonomy(err, ErrorTaxonomy.MODEL_FAILURE)).toBe(false);
    });

    it("getErrorTaxonomy extracts taxonomy from errors", () => {
      const openClawErr = new SchemaViolationError("Test", {});
      expect(getErrorTaxonomy(openClawErr)).toBe(ErrorTaxonomy.SCHEMA_VIOLATION);

      expect(getErrorTaxonomy(new Error("Regular"))).toBe(ErrorTaxonomy.UNKNOWN);
      expect(getErrorTaxonomy("string")).toBe(ErrorTaxonomy.UNKNOWN);
    });
  });

  describe("Error Context and Cause", () => {
    it("preserves context in error", () => {
      const context = { requestId: "req-123", taskId: "task-456" };
      const err = new SchemaViolationError("Test", { context });

      expect(err.context).toEqual(context);
    });

    it("preserves cause in error chain", () => {
      const cause = new Error("Original error");
      const err = new SchemaViolationError("Wrapped", { cause });

      expect(err.cause).toBe(cause);
    });

    it("includes timestamp in error", () => {
      const before = Date.now();
      const err = new SchemaViolationError("Test", {});
      const after = Date.now();

      expect(err.timestamp).toBeGreaterThanOrEqual(before);
      expect(err.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
