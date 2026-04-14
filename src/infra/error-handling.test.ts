import { describe, expect, it, vi } from "vitest";
import {
  InfraError,
  AggregateInfraError,
  TimeoutError,
  CleanupError,
  wrapError,
  withErrorBoundary,
  withAggregatedErrors,
  withTimeout,
  isRecoverableError,
  shouldRetryError,
  getUserFriendlyMessage,
  createErrorReport,
} from "./error-handling.js";

describe("InfraError", () => {
  it("creates error with default code", () => {
    const err = new InfraError("test error");
    expect(err.message).toBe("test error");
    expect(err.code).toBe("INFRA_ERROR");
    expect(err.name).toBe("InfraError");
    expect(err.timestamp).toBeInstanceOf(Date);
  });

  it("creates error with custom code and metadata", () => {
    const err = new InfraError("test error", {
      code: "CUSTOM_CODE",
      metadata: { foo: "bar" },
    });
    expect(err.code).toBe("CUSTOM_CODE");
    expect(err.metadata).toEqual({ foo: "bar" });
  });

  it("preserves cause", () => {
    const cause = new Error("root cause");
    const err = new InfraError("wrapper", { cause });
    expect(err.cause).toBe(cause);
  });

  it("serializes to JSON", () => {
    const err = new InfraError("test", {
      code: "TEST",
      metadata: { key: "value" },
    });
    const json = err.toJSON();
    expect(json.name).toBe("InfraError");
    expect(json.message).toBe("test");
    expect(json.code).toBe("TEST");
    expect(json.metadata).toEqual({ key: "value" });
  });
});

describe("AggregateInfraError", () => {
  it("aggregates multiple errors", () => {
    const errors = [new Error("one"), new Error("two")];
    const err = new AggregateInfraError("multiple failures", errors);
    expect(err.errors).toHaveLength(2);
    expect(err.code).toBe("AGGREGATE_ERROR");
    expect(err.metadata.errorCount).toBe(2);
  });

  it("freezes errors array", () => {
    const errors = [new Error("one")];
    const err = new AggregateInfraError("test", errors);
    expect(Object.isFrozen(err.errors)).toBe(true);
  });
});

describe("TimeoutError", () => {
  it("includes timeout duration", () => {
    const err = new TimeoutError("timed out", 5000);
    expect(err.timeoutMs).toBe(5000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.metadata.timeoutMs).toBe(5000);
  });
});

describe("CleanupError", () => {
  it("has cleanup code", () => {
    const err = new CleanupError("cleanup failed");
    expect(err.code).toBe("CLEANUP_FAILED");
    expect(err.name).toBe("CleanupError");
  });
});

describe("wrapError", () => {
  it("wraps error with context", () => {
    const original = new Error("original");
    const wrapped = wrapError(original, {
      operation: "test-operation",
      subsystem: "test-subsystem",
    });
    expect(wrapped.message).toContain("test-operation failed");
    expect(wrapped.cause).toBe(original);
    expect(wrapped.metadata.operation).toBe("test-operation");
    expect(wrapped.metadata.subsystem).toBe("test-subsystem");
  });
});

describe("withErrorBoundary", () => {
  it("returns result on success", async () => {
    const result = await withErrorBoundary(async () => "success", {
      operation: "test",
      suppressLog: true,
    });
    expect(result).toBe("success");
  });

  it("wraps and rethrows error on failure", async () => {
    await expect(
      withErrorBoundary(
        async () => {
          throw new Error("fail");
        },
        { operation: "test", suppressLog: true },
      ),
    ).rejects.toThrow(InfraError);
  });

  it("calls onError callback", async () => {
    const onError = vi.fn();
    await expect(
      withErrorBoundary(
        async () => {
          throw new Error("fail");
        },
        { operation: "test", onError, suppressLog: true },
      ),
    ).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it("transforms error when transform provided", async () => {
    const customError = new Error("custom");
    await expect(
      withErrorBoundary(
        async () => {
          throw new Error("original");
        },
        { operation: "test", transform: () => customError, suppressLog: true },
      ),
    ).rejects.toBe(customError);
  });
});

describe("withAggregatedErrors", () => {
  it("collects results from successful operations", async () => {
    const { results, errors } = await withAggregatedErrors(
      [
        { label: "a", fn: async () => 1 },
        { label: "b", fn: async () => 2 },
      ],
      { continueOnError: true },
    );
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it("collects errors when continueOnError is true", async () => {
    const { results, errors } = await withAggregatedErrors(
      [
        { label: "a", fn: async () => 1 },
        {
          label: "b",
          fn: async () => {
            throw new Error("fail");
          },
        },
      ],
      { continueOnError: true },
    );
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].label).toBe("b");
  });

  it("throws AggregateInfraError when continueOnError is false", async () => {
    await expect(
      withAggregatedErrors([
        {
          label: "a",
          fn: async () => {
            throw new Error("fail");
          },
        },
      ]),
    ).rejects.toThrow(AggregateInfraError);
  });
});

describe("withTimeout", () => {
  it("returns result before timeout", async () => {
    const result = await withTimeout(async () => "success", 1000);
    expect(result).toBe("success");
  });

  it("throws TimeoutError on timeout", async () => {
    await expect(
      withTimeout(() => new Promise((resolve) => setTimeout(resolve, 100)), 10),
    ).rejects.toThrow(TimeoutError);
  });

  it("calls onTimeout callback", async () => {
    const onTimeout = vi.fn();
    await expect(
      withTimeout(() => new Promise((resolve) => setTimeout(resolve, 100)), 10, {
        onTimeout,
      }),
    ).rejects.toThrow();
    expect(onTimeout).toHaveBeenCalled();
  });
});

describe("isRecoverableError", () => {
  it("returns true for timeout errors", () => {
    const err = new Error("timeout");
    expect(isRecoverableError(err)).toBe(true);
  });

  it("returns true for rate limit errors", () => {
    const err = new Error("rate limit exceeded");
    expect(isRecoverableError(err)).toBe(true);
  });

  it("returns false for refusal errors", () => {
    const err = new Error("content_filter triggered");
    expect(isRecoverableError(err)).toBe(false);
  });
});

describe("shouldRetryError", () => {
  it("returns false for refusal errors", () => {
    const err = new Error("refusal");
    expect(shouldRetryError(err)).toBe(false);
  });

  it("returns true for connection reset", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(shouldRetryError(err)).toBe(true);
  });
});

describe("getUserFriendlyMessage", () => {
  it("returns friendly message for timeout", () => {
    const err = new Error("timeout");
    expect(getUserFriendlyMessage(err)).toBe("The operation timed out. Please try again.");
  });

  it("returns friendly message for rate limit", () => {
    const err = new Error("rate limit");
    expect(getUserFriendlyMessage(err)).toContain("Too many requests");
  });

  it("returns original message for unknown errors", () => {
    const err = new Error("something else");
    expect(getUserFriendlyMessage(err)).toBe("something else");
  });
});

describe("createErrorReport", () => {
  it("creates structured report", () => {
    const err = new InfraError("test", { code: "TEST", metadata: { key: "val" } });
    const report = createErrorReport(err);
    expect(report.message).toBe("test");
    expect(report.code).toBe("TEST");
    expect(report.metadata).toEqual({ key: "val" });
    expect(report.timestamp).toBeDefined();
  });

  it("includes cause chain", () => {
    const cause = new Error("root");
    const err = new Error("wrapper");
    err.cause = cause;
    const report = createErrorReport(err);
    expect(report.cause).toBeDefined();
  });
});
