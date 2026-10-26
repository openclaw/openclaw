import { afterEach, expect, it, onTestFinished, vi } from "vitest";

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
  const exit = vi.fn(() => createNonExitingRuntime().exit(42));
  expect(exit).toThrow(ExitError);
  const [result] = exit.mock.results;
  expect(result?.value).toBeInstanceOf(Error);
  expect(result?.value).toMatchObject({ name: "ExitError", message: "exit 42", code: 42 });
});

it.each([false, true])("routes runtime output (direct writer: %s)", (direct) => {
  const runtime = direct ? makeOutputRuntime() : makeRuntime();
  writeRuntimeStdout(runtime, "plain output");
  writeRuntimeJson(runtime, { key: "value" });
  if ("writeStdout" in runtime) {
    expect(runtime.writeStdout).toHaveBeenCalledWith("plain output");
    expect(runtime.writeJson).toHaveBeenCalledWith({ key: "value" }, 2);
    expect(runtime.log).not.toHaveBeenCalled();
  } else {
    expect(runtime.log.mock.calls).toEqual([["plain output"], ['{\n  "key": "value"\n}']]);
    writeRuntimeJson(runtime, { key: "value" }, 0);
    expect(runtime.log).toHaveBeenLastCalledWith('{"key":"value"}');
  }
});

const originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
afterEach(() => {
  vi.restoreAllMocks();
  loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
});
function capture(stream: NodeJS.WriteStream) {
  const isTTY = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  onTestFinished(() => {
    if (isTTY) {
      Object.defineProperty(stream, "isTTY", isTTY);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  });
  const write = vi.spyOn(stream, "write").mockReturnValue(true);
  return () => write.mock.calls.map(([chunk]) => String(chunk)).join("");
}

it.each(["stdout", "stderr", "custom"])("restores the terminal on %s", (destination) => {
  const stdout = capture(process.stdout);
  const stderr = capture(process.stderr);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("forced native exit");
  });
  const json = destination !== "stdout";
  const resetWrite = vi.fn(() => true);
  const resetStream = { isTTY: true, write: resetWrite } as unknown as NodeJS.WriteStream;
  loggingState.forceConsoleToStderr = json;
  if (json) {
    defaultRuntime.writeJson({ ok: false });
  } else {
    defaultRuntime.writeStdout("operator-visible output");
  }
  const options = destination === "custom" ? { resetStream } : undefined;
  expect(() => defaultRuntime.exit(1, options)).toThrow(ExitError);
  if (json) {
    expect(JSON.parse(stdout())).toEqual({ ok: false });
  } else {
    expect(stdout()).toContain("operator-visible output\n");
  }
  expect(
    destination === "custom" ? resetWrite.mock.calls.flat().join("") : (json ? stderr : stdout)(),
  ).toContain("\x1b[?25h");
  if (destination !== "stderr") {
    expect(process.stderr.write).not.toHaveBeenCalled();
  }
});
