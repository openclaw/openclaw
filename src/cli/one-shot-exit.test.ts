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
});
