// Tests for terminal runtime helpers.
import { describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("../packages/terminal-core/src/progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

vi.mock("../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

import { createNonExitingRuntime, ExitError, writeRuntimeJson } from "./runtime.js";

describe("createNonExitingRuntime", () => {
  it("returns runtime with exit function", () => {
    const runtime = createNonExitingRuntime();
    expect(typeof runtime.exit).toBe("function");
  });

  it("exit function throws ExitError", () => {
    const runtime = createNonExitingRuntime();
    expect(() => runtime.exit(1)).toThrow(ExitError);
  });

  it("exit function throws with correct exit code", () => {
    const runtime = createNonExitingRuntime();
    try {
      runtime.exit(42);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).exitCode).toBe(42);
      expect((err as ExitError).message).toBe("exit 42");
      expect((err as ExitError).name).toBe("ExitError");
    }
  });

  it("ExitError is distinguishable from generic Error", () => {
    const runtime = createNonExitingRuntime();
    try {
      runtime.exit(1);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ExitError);
    }

    const genericError = new Error("exit 1");
    expect(genericError).toBeInstanceOf(Error);
    expect(genericError).not.toBeInstanceOf(ExitError);
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
