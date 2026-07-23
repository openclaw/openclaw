import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  flushExitAfterOneShotOutput,
  requestExitAfterOneShotOutput,
  requestExitAfterSystemCaCliCompletion,
  runCliWithExitFinalization,
} from "./one-shot-exit.js";

describe("one-shot CLI exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["NODE_USE_SYSTEM_CA", { NODE_USE_SYSTEM_CA: "1" }, []],
    ["execArgv", {}, ["--use-system-ca"]],
    ["underscored execArgv", {}, ["--use_system_ca"]],
    ["NODE_OPTIONS", { NODE_OPTIONS: "'--use-system-ca'" }, []],
    ["underscored NODE_OPTIONS", { NODE_OPTIONS: "--use_system_ca" }, []],
  ] as const)(
    "requests a post-teardown exit for macOS system CA from %s",
    async (_label, env, execArgv) => {
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

      expect(
        requestExitAfterSystemCaCliCompletion(defaultRuntime, {
          env: env as NodeJS.ProcessEnv,
          execArgv,
          platform: "darwin",
          exitCode: 3,
        }),
      ).toBe(true);
      flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    },
  );

  it.each([
    ["non-macOS", "linux" as const, { NODE_USE_SYSTEM_CA: "1" }, []],
    ["system CA disabled", "darwin" as const, { NODE_USE_SYSTEM_CA: "0" }, []],
  ])("does not request a completion exit when %s", (_label, platform, env, execArgv) => {
    expect(
      requestExitAfterSystemCaCliCompletion(defaultRuntime, {
        env: env as NodeJS.ProcessEnv,
        execArgv: execArgv as string[],
        platform,
      }),
    ).toBe(false);
  });

  it("does not finalize a long-lived command until its run promise settles", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    let finishRun: (() => void) | undefined;
    const runPromise = runCliWithExitFinalization({
      run: async () =>
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
      onError: vi.fn(),
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).not.toHaveBeenCalled();

    finishRun?.();
    await runPromise;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("reports failures and sets their status before draining the system CA exit", async () => {
    const previousExitCode = process.exitCode;
    const order: string[] = [];
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      order.push(`exit:${String(code)}`);
    });

    try {
      process.exitCode = undefined;
      requestExitAfterOneShotOutput(defaultRuntime, 0);
      await runCliWithExitFinalization({
        run: async () => {
          throw new Error("command failed");
        },
        onError: async () => {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          order.push("reported");
          process.exitCode = 6;
        },
        env: { NODE_USE_SYSTEM_CA: "1" },
        execArgv: [],
        platform: "darwin",
        markers: {},
      });

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(6));
      expect(order).toEqual(["reported", "exit:6"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("resolves the process exit code after a system CA completion request", async () => {
    const previousExitCode = process.exitCode;
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

    try {
      process.exitCode = undefined;
      requestExitAfterSystemCaCliCompletion(defaultRuntime, {
        env: { NODE_USE_SYSTEM_CA: "1" },
        execArgv: [],
        platform: "darwin",
      });
      flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});
      process.exitCode = "9";

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(9));
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves a command-specific exit code when system CA completion also requests exit", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

    requestExitAfterOneShotOutput(defaultRuntime, 7);
    requestExitAfterSystemCaCliCompletion(defaultRuntime, {
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      exitCode: 0,
    });
    flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(7));
  });

  it("defers the requested exit code until the top-level flush", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

    expect(requestExitAfterOneShotOutput(defaultRuntime, 2)).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(exit).not.toHaveBeenCalled();
    flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
  });

  it("does not request exits for embedded custom runtimes", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    expect(requestExitAfterOneShotOutput(runtime)).toBe(false);
    flushExitAfterOneShotOutput(runtime, {} as NodeJS.ProcessEnv, {});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("suppresses exits inside Vitest workers but not spawned CLI children", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    const inheritedTestEnv = { VITEST: "1", VITEST_WORKER_ID: "1" } as NodeJS.ProcessEnv;

    requestExitAfterOneShotOutput(defaultRuntime);
    flushExitAfterOneShotOutput(defaultRuntime, inheritedTestEnv, { tinypoolState: {} });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).not.toHaveBeenCalled();

    requestExitAfterOneShotOutput(defaultRuntime);
    flushExitAfterOneShotOutput(defaultRuntime, inheritedTestEnv, {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("waits for stream callbacks even when writableLength is zero", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(0);
    vi.spyOn(process.stderr, "writableLength", "get").mockReturnValue(0);

    let flushStdout: (() => void) | undefined;
    let flushStderr: (() => void) | undefined;
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      flushStdout = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stdout.write);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      flushStderr = args.find((arg): arg is () => void => typeof arg === "function");
      return true;
    }) as typeof process.stderr.write);

    requestExitAfterOneShotOutput(defaultRuntime);
    flushExitAfterOneShotOutput(defaultRuntime, {} as NodeJS.ProcessEnv, {});

    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    flushStdout?.();
    expect(exit).not.toHaveBeenCalled();
    flushStderr?.();
    expect(exit).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
