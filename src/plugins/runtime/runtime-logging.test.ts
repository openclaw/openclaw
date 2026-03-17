import { beforeEach, describe, expect, it, vi } from "vitest";
import * as globalsModule from "../../globals.js";
import * as loggingModule from "../../logging.js";
import { createRuntimeLogging } from "./runtime-logging.js";

describe("createRuntimeLogging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes meta through RuntimeLogger methods", () => {
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

    expect(debug).toHaveBeenCalledWith("debug message", meta);
    expect(info).toHaveBeenCalledWith("info message", meta);
    expect(warn).toHaveBeenCalledWith("warn message", meta);
    expect(error).toHaveBeenCalledWith("error message", meta);
  });

  it("re-exports shouldLogVerbose", () => {
    const runtimeLogging = createRuntimeLogging();
    expect(runtimeLogging.shouldLogVerbose).toBe(globalsModule.shouldLogVerbose);
  });
});
