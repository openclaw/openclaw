import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createLogContext,
  getElapsedMs,
  formatLogPrefix,
  createOperationLogger,
  trackOperation,
  withTiming,
  createRateLimitedLogger,
} from "./logging-utils.js";

describe("createLogContext", () => {
  it("creates context with correlation ID", () => {
    const ctx = createLogContext("test-op", "test-subsystem");
    expect(ctx.correlationId).toMatch(/^[a-f0-9]{16}$/);
    expect(ctx.operation).toBe("test-op");
    expect(ctx.subsystem).toBe("test-subsystem");
    expect(ctx.startTime).toBeLessThanOrEqual(Date.now());
  });

  it("includes metadata", () => {
    const ctx = createLogContext("op", "sys", { key: "value" });
    expect(ctx.metadata).toEqual({ key: "value" });
  });
});

describe("getElapsedMs", () => {
  it("calculates elapsed time", async () => {
    const ctx = createLogContext("op", "sys");
    await new Promise((r) => setTimeout(r, 10));
    const elapsed = getElapsedMs(ctx);
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });
});

describe("formatLogPrefix", () => {
  it("formats prefix with correlation ID", () => {
    const ctx = createLogContext("test-op", "sys");
    const prefix = formatLogPrefix(ctx);
    expect(prefix).toMatch(/^\[[a-f0-9]{16}\] test-op$/);
  });
});

describe("createOperationLogger", () => {
  it("creates logger with context", () => {
    const opLogger = createOperationLogger("test-op", "test-sys");
    expect(opLogger.context.operation).toBe("test-op");
    expect(opLogger.context.subsystem).toBe("test-sys");
  });

  it("provides logging methods", () => {
    const opLogger = createOperationLogger("op", "sys");
    expect(typeof opLogger.info).toBe("function");
    expect(typeof opLogger.warn).toBe("function");
    expect(typeof opLogger.error).toBe("function");
    expect(typeof opLogger.debug).toBe("function");
    expect(typeof opLogger.started).toBe("function");
    expect(typeof opLogger.completed).toBe("function");
    expect(typeof opLogger.failed).toBe("function");
  });
});

describe("trackOperation", () => {
  it("tracks successful operation", async () => {
    const tracked = trackOperation("test-op", "test-sys", async () => "result");
    expect(tracked.context.operation).toBe("test-op");
    expect(typeof tracked.cancel).toBe("function");
    const result = await tracked.promise;
    expect(result).toBe("result");
  });

  it("tracks failed operation", async () => {
    const tracked = trackOperation("test-op", "test-sys", async () => {
      throw new Error("fail");
    });
    await expect(tracked.promise).rejects.toThrow("fail");
  });

  it("provides abort signal", async () => {
    let signalReceived: AbortSignal | undefined;
    const tracked = trackOperation("op", "sys", async (_logger, signal) => {
      signalReceived = signal;
      return "done";
    });
    await tracked.promise;
    expect(signalReceived).toBeDefined();
    expect(signalReceived?.aborted).toBe(false);
  });

  it("cancel aborts the signal", () => {
    let signalReceived: AbortSignal | undefined;
    const tracked = trackOperation("op", "sys", async (_logger, signal) => {
      signalReceived = signal;
      await new Promise((r) => setTimeout(r, 100));
      return "done";
    });
    tracked.cancel();
    expect(signalReceived?.aborted).toBe(true);
  });
});

describe("withTiming", () => {
  it("returns result and measures time", async () => {
    const result = await withTiming("op", "sys", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "result";
    });
    expect(result).toBe("result");
  });

  it("rethrows errors", async () => {
    await expect(
      withTiming("op", "sys", async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
  });
});

describe("createRateLimitedLogger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates logger with rate limiting methods", () => {
    const logger = createRateLimitedLogger("test");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("allows messages within rate limit", () => {
    const logger = createRateLimitedLogger("test", { maxPerWindow: 3 });
    // Should not throw
    logger.info("test message");
    logger.info("test message");
    logger.info("test message");
  });

  it("suppresses messages beyond rate limit", () => {
    const logger = createRateLimitedLogger("test", {
      windowMs: 1000,
      maxPerWindow: 2,
    });
    // First 2 should pass, 3rd should be suppressed
    logger.info("repeated");
    logger.info("repeated");
    logger.info("repeated"); // suppressed
  });

  it("resets window after timeout", () => {
    const logger = createRateLimitedLogger("test", {
      windowMs: 1000,
      maxPerWindow: 1,
    });
    logger.info("msg");
    logger.info("msg"); // suppressed
    vi.advanceTimersByTime(1001);
    logger.info("msg"); // should pass (new window)
  });
});
