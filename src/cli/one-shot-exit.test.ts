import { describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { exitAfterOneShotOutput, shouldForceExitAfterOneShotOutput } from "./one-shot-exit.js";

describe("one-shot CLI exit", () => {
  it("does not force exits inside Vitest workers", () => {
    expect(
      shouldForceExitAfterOneShotOutput(defaultRuntime, { VITEST: "true" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      shouldForceExitAfterOneShotOutput(defaultRuntime, {
        VITEST_WORKER_ID: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("does not force exits for embedded custom runtimes", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    exitAfterOneShotOutput(runtime, {} as NodeJS.ProcessEnv);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(shouldForceExitAfterOneShotOutput(runtime, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldForceExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("drains stdout and stderr before forcing default runtime exit", () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(4);
    vi.spyOn(process.stderr, "writableLength", "get").mockReturnValue(4);

    let flushStdout: (() => void) | undefined;
    let flushStderr: (() => void) | undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
      flushStdout = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((...args: unknown[]) => {
      flushStderr = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stderr.write);

    exitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv);

    expect(exit).not.toHaveBeenCalled();
    flushStdout?.();
    expect(exit).not.toHaveBeenCalled();
    flushStderr?.();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
