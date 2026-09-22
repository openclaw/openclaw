import { describe, expect, it, vi } from "vitest";
import { logRunError } from "./run-error.js";
import type { SubsystemLogger } from "./subsystem.js";

function createLogger() {
  return {
    isEnabled: vi.fn(() => true),
    error: vi.fn<SubsystemLogger["error"]>(),
  };
}

describe("logRunError", () => {
  it("retains native and aggregate stacks without invoking error conversion hooks", () => {
    const logger = createLogger();
    const stackGetter = vi.fn(() => {
      throw new Error("Custom stack accessor must not run");
    });
    const opaque = new Error("opaque sibling");
    Object.defineProperty(opaque, "stack", { get: stackGetter });
    const cause = new Error("worker diagnostic password=synthetic-password");
    cause.stack =
      "Error: worker diagnostic password=synthetic-password\n    at allocateWorker (fixture.ts:42:1)";
    const toJSON = vi.fn(() => {
      throw new Error("Error conversion must not run");
    });
    const failure = Object.assign(
      new Error("worker unavailable", { cause: new AggregateError([cause, opaque], "workers") }),
      { attemptCount: 42n, toJSON },
    );

    logRunError(logger, "agent run failed", { runId: "run-original", error: failure });

    expect(logger.error).toHaveBeenCalledOnce();
    const metadata = logger.error.mock.calls[0]?.[1];
    expect(metadata).toMatchObject({ runId: "run-original", diagnosticTruncated: false });
    const diagnostic = String(metadata?.diagnostic);
    const logged = JSON.parse(diagnostic);
    expect(logged.error).toMatchObject({
      message: "worker unavailable",
      attemptCount: "42",
      cause: { message: "workers" },
    });
    // The outer stack stays native, including on Node versions with a lazy accessor.
    expect(logged.stacks).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Error: worker unavailable"),
        expect.stringContaining("at allocateWorker (fixture.ts:42:1)"),
      ]),
    );
    expect(diagnostic).not.toContain("synthetic-password");
    expect(stackGetter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("bounds cyclic aggregate graphs while retaining readable siblings", () => {
    const logger = createLogger();
    const children = Array.from({ length: 70 }, (_, index) =>
      Object.assign(new Error(`child ${index}`), { stack: `child stack ${index}` }),
    );
    const failure = new AggregateError(children, "worker failures");
    failure.cause = failure;

    logRunError(logger, "agent run failed", { runId: "run-many", error: failure });

    const diagnostic = JSON.parse(String(logger.error.mock.calls[0]?.[1]?.diagnostic));
    expect(diagnostic.error.cause).toBe("[Circular]");
    expect(diagnostic.stacks).toContain("child stack 0");
    expect(diagnostic.stacks.length).toBeLessThanOrEqual(64);
    expect(diagnostic.stacks).not.toContain("child stack 69");
  });

  it("keeps the native stack ahead of large metadata and clips after redaction", () => {
    const logger = createLogger();
    const failure = Object.assign(new Error("startup failure"), {
      detail: `${"x".repeat(99_000)} password=${"synthetic-secret-".repeat(100)}\n${"y".repeat(2_000)}`,
    });

    logRunError(logger, "agent run failed", { runId: "run-large", error: failure });

    const metadata = logger.error.mock.calls[0]?.[1];
    const diagnostic = String(metadata?.diagnostic);
    expect(metadata?.diagnosticTruncated).toBe(true);
    expect(diagnostic).toHaveLength(100_000);
    expect(diagnostic).toContain("Error: startup failure");
    expect(diagnostic).not.toContain("synthetic-secret");
  });

  it("does not inspect the original error when logging is disabled", () => {
    const logger = createLogger();
    logger.isEnabled.mockReturnValue(false);
    const ownKeys = vi.fn(() => {
      throw new Error("Disabled diagnostics must not inspect the error");
    });
    const failure = new Proxy({}, { ownKeys });

    logRunError(logger, "agent run failed", { runId: "run-disabled", error: failure });

    expect(ownKeys).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
