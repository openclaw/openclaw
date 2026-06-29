// Tests for terminal runtime helpers.
import { describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("../packages/terminal-core/src/progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

vi.mock("../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

import { createNonExitingRuntime, RuntimeExitError, writeRuntimeJson } from "./runtime.js";

describe("createNonExitingRuntime", () => {
  it("returns runtime with exit function", () => {
    const runtime = createNonExitingRuntime();
    expect(typeof runtime.exit).toBe("function");
  });

  it("exit function throws typed runtime exit error", () => {
    const runtime = createNonExitingRuntime();
    let thrown: unknown;

    try {
      runtime.exit(42);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RuntimeExitError);
    expect(thrown).toMatchObject({
      name: "RuntimeExitError",
      code: 42,
      message: "exit 42",
    });
  });

  it("exit function includes code in error message", () => {
    const runtime = createNonExitingRuntime();
    expect(() => runtime.exit(42)).toThrow("exit 42");
  });
});

describe("writeRuntimeJson", () => {
  it("writes JSON using writeJson when available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" });
    expect(runtime.writeJson).toHaveBeenCalledWith({ key: "value" }, 2);
  });

  it("writes JSON using log when writeJson not available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" });
    expect(runtime.log).toHaveBeenCalled();
  });

  it("uses custom space parameter", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" }, 4);
    expect(runtime.writeJson).toHaveBeenCalledWith({ key: "value" }, 4);
  });

  it("handles zero space parameter", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    writeRuntimeJson(runtime, { key: "value" }, 0);
    expect(runtime.log).toHaveBeenCalledWith('{"key":"value"}');
  });
});
