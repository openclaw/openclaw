import { beforeEach, describe, expect, it, vi } from "vitest";
import * as globalsModule from "../../globals.js";
import * as loggingModule from "../../logging.js";
import { createRuntimeLogging } from "./runtime-logging.js";

describe("createRuntimeLogging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes structured meta as the first logger argument", () => {
    const debug = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const meta = { runId: "run-1", attempt: 2 };

    vi.spyOn(loggingModule, "getChildLogger").mockReturnValue({
      debug,
      info,
      warn,
      error,
    } as unknown as ReturnType<typeof loggingModule.getChildLogger>);

    const runtimeLogging = createRuntimeLogging();
    const logger = runtimeLogging.getChildLogger({ plugin: "demo" });

    logger.debug?.("debug message", meta);
    logger.info("info message", meta);
    logger.warn("warn message", meta);
    logger.error("error message", meta);

    expect(debug).toHaveBeenCalledWith(meta, "debug message");
    expect(info).toHaveBeenCalledWith(meta, "info message");
    expect(warn).toHaveBeenCalledWith(meta, "warn message");
    expect(error).toHaveBeenCalledWith(meta, "error message");
  });

  it("omits the meta argument when no structured fields are provided", () => {
    const debug = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    vi.spyOn(loggingModule, "getChildLogger").mockReturnValue({
      debug,
      info,
      warn,
      error,
    } as unknown as ReturnType<typeof loggingModule.getChildLogger>);

    const runtimeLogging = createRuntimeLogging();
    const logger = runtimeLogging.getChildLogger({ plugin: "demo" });

    logger.debug?.("debug message");
    logger.info("info message", {});
    logger.warn("warn message");
    logger.error("error message", {});

    expect(debug).toHaveBeenCalledWith("debug message");
    expect(info).toHaveBeenCalledWith("info message");
    expect(warn).toHaveBeenCalledWith("warn message");
    expect(error).toHaveBeenCalledWith("error message");
  });

  it("re-exports shouldLogVerbose", () => {
    const runtimeLogging = createRuntimeLogging();
    expect(runtimeLogging.shouldLogVerbose).toBe(globalsModule.shouldLogVerbose);
  });
});
