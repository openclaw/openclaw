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

describe("writeRuntimeJson", () => {
  it("writes JSON using writeJson when available", () => {
    const runtime = makeOutputRuntime();
    writeRuntimeJson(runtime, { key: "value" });
    expect(runtime.writeJson).toHaveBeenCalledWith({ key: "value" }, 2);
  });

  it.each([
    [undefined, '{\n  "key": "value"\n}'],
    [0, '{"key":"value"}'],
  ] as const)("writes JSON through log with space %s", (space, expected) => {
    const runtime = makeRuntime();
    writeRuntimeJson(runtime, { key: "value" }, space);
    expect(runtime.log).toHaveBeenCalledWith(expected);
  });
});

describe("writeRuntimeStdout", () => {
  it("uses the direct stdout writer when available", () => {
    const runtime = makeOutputRuntime();
    writeRuntimeStdout(runtime, "plain output");

    expect(runtime.writeStdout).toHaveBeenCalledWith("plain output");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("falls back to the runtime logger when no stdout writer is available", () => {
    const runtime = makeRuntime();
    writeRuntimeStdout(runtime, "plain output");

    expect(runtime.log).toHaveBeenCalledWith("plain output");
  });
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
