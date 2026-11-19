import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/terminal-core/src/progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

import { loggingState } from "./logging/state.js";
import {
  createNonExitingRuntime,
  defaultRuntime,
  ExitError,
  writeRuntimeJson,
  writeRuntimeStdout,
} from "./runtime.js";

const makeRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });
const makeOutputRuntime = () => ({ ...makeRuntime(), writeStdout: vi.fn(), writeJson: vi.fn() });

it("throws a typed exit error carrying the requested code", () => {
  let thrown: unknown;
  try {
    createNonExitingRuntime().exit(42);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExitError);
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toMatchObject({ name: "ExitError", message: "exit 42", code: 42 });
});

it.each([
  [true, undefined, { key: "value" }],
  [false, undefined, '{\n  "key": "value"\n}'],
  [false, 0, '{"key":"value"}'],
] as const)("writes JSON (direct: %s, space: %s)", (direct, space, expected) => {
  const runtime = direct ? makeOutputRuntime() : makeRuntime();
  writeRuntimeJson(runtime, { key: "value" }, space);
  if ("writeJson" in runtime) {
    expect(runtime.writeJson).toHaveBeenCalledWith(expected, 2);
  } else {
    expect(runtime.log).toHaveBeenCalledWith(expected);
  }
});

it.each([false, true])("writes stdout (direct writer: %s)", (direct) => {
  const runtime = direct ? makeOutputRuntime() : makeRuntime();
  writeRuntimeStdout(runtime, "plain output");
  if ("writeStdout" in runtime) {
    expect(runtime.writeStdout).toHaveBeenCalledWith("plain output");
    expect(runtime.log).not.toHaveBeenCalled();
  } else {
    expect(runtime.log).toHaveBeenCalledWith("plain output");
  }
});

describe("defaultRuntime terminal restoration", () => {
  const originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const streams = [
    { stream: process.stdout, chunks: stdout },
    { stream: process.stderr, chunks: stderr },
  ].map(({ stream, chunks }) => ({
    stream,
    chunks,
    isTTY: Object.getOwnPropertyDescriptor(stream, "isTTY"),
  }));

  afterEach(() => {
    vi.restoreAllMocks();
    loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
    for (const { stream, isTTY } of streams) {
      if (isTTY) {
        Object.defineProperty(stream, "isTTY", isTTY);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    }
  });

  beforeEach(() => {
    for (const { stream, chunks } of streams) {
      Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
      chunks.length = 0;
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
    }
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("forced native exit");
    });
  });

  it.each([false, true])("restores the terminal without corrupting output (JSON: %s)", (json) => {
    loggingState.forceConsoleToStderr = json;
    if (json) {
      defaultRuntime.writeJson({ ok: false });
    } else {
      defaultRuntime.writeStdout("operator-visible output");
    }
    expect(() => defaultRuntime.exit(1)).toThrow(ExitError);
    if (json) {
      expect(JSON.parse(stdout.join(""))).toEqual({ ok: false });
      expect(stderr.join("")).toContain("\x1b[?25h");
    } else {
      expect(stdout.join("")).toContain("operator-visible output\n");
      expect(stdout.join("")).toContain("\x1b[?25h");
      expect(stderr).toEqual([]);
    }
  });

  it("honors an explicitly selected reset stream in machine-output mode", () => {
    const resetWrite = vi.fn(() => true);
    const resetStream = { isTTY: true, write: resetWrite } as unknown as NodeJS.WriteStream;
    loggingState.forceConsoleToStderr = true;

    expect(() => defaultRuntime.exit(1, { resetStream })).toThrow(ExitError);

    expect(resetWrite).toHaveBeenCalledWith(expect.stringContaining("\x1b[?25h"));
    expect([stdout, stderr]).toEqual([[], []]);
  });
});
