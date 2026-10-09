// Tests for terminal runtime helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/terminal-core/src/progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

vi.mock("../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

import { restoreTerminalState } from "../packages/terminal-core/src/restore.js";
import { loggingState } from "./logging/state.js";
import {
  createNonExitingRuntime,
  defaultRuntime,
  ExitError,
  writeRuntimeJson,
  writeRuntimeStdout,
} from "./runtime.js";

describe("createNonExitingRuntime", () => {
  it("throws a typed exit error carrying the requested code", () => {
    const runtime = createNonExitingRuntime();
    let thrown: unknown;

    try {
      runtime.exit(42);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExitError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      name: "ExitError",
      message: "exit 42",
      code: 42,
    });
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

describe("writeRuntimeStdout", () => {
  it("uses the direct stdout writer when available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    writeRuntimeStdout(runtime, "plain output");

    expect(runtime.writeStdout).toHaveBeenCalledWith("plain output");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("falls back to the runtime logger when no stdout writer is available", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    writeRuntimeStdout(runtime, "plain output");

    expect(runtime.log).toHaveBeenCalledWith("plain output");
  });
});

describe("defaultRuntime terminal restoration", () => {
  const originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
  const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalStderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(restoreTerminalState).mockReset();
    loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    if (originalStderrIsTTY) {
      Object.defineProperty(process.stderr, "isTTY", originalStderrIsTTY);
    } else {
      Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });

  const stdout: string[] = [];
  const stderr: string[] = [];

  beforeEach(async () => {
    const actualRestore = await vi.importActual<
      typeof import("../packages/terminal-core/src/restore.js")
    >("../packages/terminal-core/src/restore.js");
    vi.mocked(restoreTerminalState).mockImplementation(actualRestore.restoreTerminalState);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    stdout.length = 0;
    stderr.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ExitError(Number(code ?? 0));
    });
  });

  it("keeps machine-readable stdout clean on exit", () => {
    loggingState.forceConsoleToStderr = true;

    defaultRuntime.writeJson({ ok: false });
    expect(() => defaultRuntime.exit(1)).toThrow(ExitError);

    expect(JSON.parse(stdout.join(""))).toEqual({ ok: false });
    expect(stderr.join("")).toContain("\x1b[?25h");
  });

  it("preserves stdout terminal restoration for human output", () => {
    loggingState.forceConsoleToStderr = false;

    defaultRuntime.writeStdout("operator-visible output");
    expect(() => defaultRuntime.exit(1)).toThrow(ExitError);

    expect(stdout.join("")).toContain("operator-visible output\n");
    expect(stdout.join("")).toContain("\x1b[?25h");
    expect(stderr).toEqual([]);
  });

  it("honors an explicitly selected reset stream in machine-output mode", () => {
    const resetWrite = vi.fn(() => true);
    const resetStream = { isTTY: true, write: resetWrite } as unknown as NodeJS.WriteStream;
    loggingState.forceConsoleToStderr = true;

    expect(() => defaultRuntime.exit(1, { resetStream })).toThrow(ExitError);

    expect(resetWrite).toHaveBeenCalledWith(expect.stringContaining("\x1b[?25h"));
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });
});
