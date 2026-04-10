// Octopus Orchestrator — OctoLogger tests (M2-16)

import { describe, expect, it, vi } from "vitest";
import {
  type LoggerProvider,
  OctoLogger,
  consoleLoggerProvider,
  noopLoggerProvider,
} from "./logging.ts";

type InfoFn = LoggerProvider["info"];
type WarnFn = LoggerProvider["warn"];
type ErrorFn = LoggerProvider["error"];
type DebugFn = LoggerProvider["debug"];

interface MockProvider extends LoggerProvider {
  info: ReturnType<typeof vi.fn<InfoFn>>;
  warn: ReturnType<typeof vi.fn<WarnFn>>;
  error: ReturnType<typeof vi.fn<ErrorFn>>;
  debug: ReturnType<typeof vi.fn<DebugFn>>;
}

function makeMockProvider(): MockProvider {
  return {
    info: vi.fn<InfoFn>(),
    warn: vi.fn<WarnFn>(),
    error: vi.fn<ErrorFn>(),
    debug: vi.fn<DebugFn>(),
  };
}

describe("OctoLogger", () => {
  it("info delegates to provider.info with component, message, and data", () => {
    const p = makeMockProvider();
    const logger = new OctoLogger("arm-fsm", p);
    const data = { armId: "a1" };
    logger.info("spawned", data);
    expect(p.info).toHaveBeenCalledWith("arm-fsm", "spawned", data);
  });

  it("warn delegates to provider.warn with component, message, and data", () => {
    const p = makeMockProvider();
    const logger = new OctoLogger("grip-fsm", p);
    const data = { reason: "timeout" };
    logger.warn("slow grip", data);
    expect(p.warn).toHaveBeenCalledWith("grip-fsm", "slow grip", data);
  });

  it("error delegates to provider.error with component, message, and data", () => {
    const p = makeMockProvider();
    const logger = new OctoLogger("event-log", p);
    const data = { code: 42 };
    logger.error("write failed", data);
    expect(p.error).toHaveBeenCalledWith("event-log", "write failed", data);
  });

  it("debug delegates to provider.debug with component, message, and data", () => {
    const p = makeMockProvider();
    const logger = new OctoLogger("registry", p);
    const data = { count: 3 };
    logger.debug("tick", data);
    expect(p.debug).toHaveBeenCalledWith("registry", "tick", data);
  });

  it("data parameter is optional and passed as undefined when omitted", () => {
    const p = makeMockProvider();
    const logger = new OctoLogger("head", p);
    logger.info("started");
    expect(p.info).toHaveBeenCalledWith("head", "started", undefined);
  });

  it("multiple calls accumulate on the provider", () => {
    const p = makeMockProvider();
    const logger = new OctoLogger("head", p);
    logger.info("a");
    logger.info("b");
    logger.warn("c");
    expect(p.info).toHaveBeenCalledTimes(2);
    expect(p.warn).toHaveBeenCalledTimes(1);
  });

  it("noopLoggerProvider does not throw on any method", () => {
    const logger = new OctoLogger("head", noopLoggerProvider);
    expect(() => {
      logger.info("a");
      logger.warn("b");
      logger.error("c");
      logger.debug("d");
    }).not.toThrow();
  });

  it("consoleLoggerProvider delegates to console without throwing", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const logger = new OctoLogger("test", consoleLoggerProvider);
      logger.info("hello", { key: "val" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
