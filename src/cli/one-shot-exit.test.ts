import { spawnSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import {
  exitCliAfterOutput,
  requestExitAfterOneShotOutput,
  runCliWithExitFinalization,
} from "./one-shot-exit.js";

const successfulRun = async () => {};
const ignoreError = () => {};
// Fresh proxy children share only temporary source transforms, not module state.
const proxyChildTempDir = useAutoCleanupTempDirTracker(afterAll).make("openclaw-proxy-child-tmp-");

const completionOptions = {
  onError: ignoreError,
  env: {},
  execArgv: [],
  platform: "linux" as const,
  markers: {},
};

function runCliChild(script: string, envOverrides: NodeJS.ProcessEnv = {}, maxBuffer?: number) {
  const env = { ...process.env, ...envOverrides };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    env,
    timeout: 30_000,
    ...(maxBuffer ? { maxBuffer } : {}),
  });
}

function spyOnExit(onExit?: (code: number) => void) {
  const exited = createDeferred();
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    onExit?.(code);
    exited.resolve();
  });
  return {
    exit,
    waitForExit: async (code: number) => {
      await withTestTimeout(exited.promise, 1_000, "one-shot CLI did not exit");
      expect(exit).toHaveBeenCalledWith(code);
    },
  };
}

describe("one-shot CLI exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unwinds the injected runtime synchronously with the requested exit code", () => {
    const exit = vi.fn();
    const runtime = { ...defaultRuntime, exit };
    const defaultExit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    let thrown: unknown;
    try {
      exitCliAfterOutput(runtime, 7);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExitError);
    expect(thrown).toMatchObject({ code: 7 });
    expect(defaultExit).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([
    { outcome: "cleanup failure after success", commandExit: undefined },
    {
      outcome: "deferred exit with cleanup reporter rethrow",
      commandExit: 7,
      reporterRethrows: true,
    },
  ])("leaves $outcome owned by the injected runtime", async ({ commandExit, reporterRethrows }) => {
    const commandFailure = commandExit === undefined ? undefined : new ExitError(commandExit);
    const cleanupFailure = new Error("state cleanup failed");
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const onError = vi.fn((error: unknown) => {
      if (reporterRethrows) {
        throw error;
      }
    });

    await expect(
      runCliWithExitFinalization({
        run: async () => {
          if (commandFailure) {
            throw commandFailure;
          }
        },
        finalize: async () => {
          throw cleanupFailure;
        },
        onError,
        runtime,
      }),
    ).rejects.toBe(commandFailure ?? cleanupFailure);

    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupFailure);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    ["underscored execArgv", {}, ["--use_system_ca"]],
    ["NODE_OPTIONS", { NODE_OPTIONS: "'--use-system-ca'" }, []],
  ] as const)(
    "exits after macOS system CA command completion from %s",
    async (_label, env, execArgv) => {
      const previousExitCode = process.exitCode;
      const { waitForExit } = spyOnExit();
      try {
        process.exitCode = 3;
        await runCliWithExitFinalization({
          run: successfulRun,
          onError: ignoreError,
          env: env as NodeJS.ProcessEnv,
          execArgv,
          platform: "darwin",
          markers: {},
        });
        await waitForExit(3);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it("does not finalize a long-lived command until its run promise settles", async () => {
    const { exit, waitForExit } = spyOnExit();
    let finishRun: (() => void) | undefined;
    const runPromise = runCliWithExitFinalization({
      run: async () =>
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
      onError: ignoreError,
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
    await waitForExit(0);
  });

  it("waits for caller-owned state cleanup before a requested exit", async () => {
    const closed = createDeferred();
    const finalizing = createDeferred();
    const previousExitCode = process.exitCode;
    const { exit, waitForExit } = spyOnExit();
    process.exitCode = undefined;
    const running = runCliWithExitFinalization({
      run: async () => {
        requestExitAfterOneShotOutput(defaultRuntime, 0);
      },
      finalize: async () => {
        finalizing.resolve();
        await closed.promise;
      },
      onError: ignoreError,
      env: {},
      execArgv: [],
      platform: "darwin",
      markers: {},
    });
    try {
      await finalizing.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(exit).not.toHaveBeenCalled();
      closed.resolve();
      await running;
      await waitForExit(0);
    } finally {
      closed.resolve();
      await running;
      process.exitCode = previousExitCode;
    }
  });

  it("reports failures and replaces a pending successful exit before draining", async () => {
    const previousExitCode = process.exitCode;
    const order: string[] = [];
    const { waitForExit } = spyOnExit((code) => {
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

      await waitForExit(6);
      expect(order).toEqual(["reported", "exit:6"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves a late integer-string process failure when no exit override was requested", async () => {
    const previousExitCode = process.exitCode;
    const { waitForExit } = spyOnExit();
    try {
      process.exitCode = undefined;
      await runCliWithExitFinalization({
        run: async () => {
          requestExitAfterOneShotOutput(defaultRuntime);
          process.exitCode = "9";
        },
        ...completionOptions,
      });
      await waitForExit(9);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("suppresses exits inside Vitest workers but not spawned CLI children", async () => {
    const { exit, waitForExit } = spyOnExit();
    const inheritedTestEnv = { VITEST: "1", VITEST_WORKER_ID: "1" } as NodeJS.ProcessEnv;

    requestExitAfterOneShotOutput(defaultRuntime);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: inheritedTestEnv,
      execArgv: [],
      platform: "linux",
      markers: { tinypoolState: {} },
    });
    expect(exit).not.toHaveBeenCalled();

    requestExitAfterOneShotOutput(defaultRuntime);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: inheritedTestEnv,
      execArgv: [],
      platform: "linux",
      markers: {},
    });
    await waitForExit(0);
  });

  it("waits for stream callbacks even when writableLength is zero", async () => {
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(0);
    vi.spyOn(process.stderr, "writableLength", "get").mockReturnValue(0);

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

    requestExitAfterOneShotOutput(defaultRuntime);
    await runCliWithExitFinalization({
      run: successfulRun,
      ...completionOptions,
    });

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

  it("falls back when stream drain callbacks never settle", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (() => true) as typeof process.stderr.write,
    );

    try {
      requestExitAfterOneShotOutput(defaultRuntime, 5);
      await runCliWithExitFinalization({
        run: successfulRun,
        ...completionOptions,
      });

      expect(exit).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(exit).toHaveBeenCalledWith(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains large piped JSON before a deferred ExitError without reporting another error", () => {
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const payloadBytes = 1024 * 1024;
    const script = `
      import { runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime, ExitError } from ${JSON.stringify(runtimeUrl)};
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeJson({ ok: false, payload: "x".repeat(${payloadBytes}) });
          throw new ExitError(7);
        },
        onError: (error) => {
          process.stderr.write("unexpected error: " + String(error));
          process.exitCode = 1;
        },
      });
    `;

    const result = runCliChild(script, {}, 2 * payloadBytes);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({ ok: false, payload: "x".repeat(payloadBytes) }, null, 2)}\n`,
    );
  });

  it("keeps the real proxy command exit truthful when --help is consumed as a proxy URL", () => {
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeSnapshotUrl = new URL("../config/runtime-snapshot.ts", import.meta.url).href;
    const argvInvocationUrl = new URL("./argv-invocation.ts", import.meta.url).href;
    const proxyCliUrl = new URL("./proxy-cli.ts", import.meta.url).href;
    const script = `
      import { Command, CommanderError } from "commander";
      import { setRuntimeConfigSnapshot } from ${JSON.stringify(runtimeSnapshotUrl)};
      import { resolveCliArgvInvocation } from ${JSON.stringify(argvInvocationUrl)};
      import { registerProxyCli } from ${JSON.stringify(proxyCliUrl)};
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};

      setRuntimeConfigSnapshot({});
      const argv = ["node", "openclaw", "proxy", "validate", ...${JSON.stringify(["--proxy-url", "--help", "--json"])}];
      await runCliWithExitFinalization({
        run: async () => {
          const program = new Command().enablePositionalOptions().exitOverride();
          registerProxyCli(program);
          try {
            await program.parseAsync(argv);
          } catch (error) {
            if (!(error instanceof CommanderError) || error.exitCode !== 0) {
              throw error;
            }
            process.exitCode = error.exitCode;
          }
          if (resolveCliArgvInvocation(argv).hasHelpOrVersion) {
            requestExitAfterOneShotOutput();
          }
        },
        onError: (error) => { throw error; },
      });
    `;

    const result = runCliChild(script, {
      OPENCLAW_STATE_DIR: "/dev/null",
      OPENCLAW_CONFIG_PATH: "/dev/null",
      TMPDIR: proxyChildTempDir,
      TEMP: proxyChildTempDir,
      TMP: proxyChildTempDir,
      NODE_DISABLE_COMPILE_CACHE: "1",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        ok: false,
        config: expect.objectContaining({
          errors: ["proxyUrl must use http:// or https://"],
        }),
      }),
    );
  });

  it("keeps real dual-TTY JSON clean for a deferred hooks failure", () => {
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const loggingStateUrl = new URL("../logging/state.ts", import.meta.url).href;
    const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      import { loggingState } from ${JSON.stringify(loggingStateUrl)};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeStdout(JSON.stringify({ ok: false }));
          requestExitAfterOneShotOutput(defaultRuntime, 1);
        },
        onError: (error) => { throw error; },
      });
    `;

    const result = runCliChild(script);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: false });
    expect(result.stderr).toContain("\x1b[?25h");
  });

  it("keeps real dual-TTY JSON clean after a fatal unhandled rejection", () => {
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const loggingStateUrl = new URL("../logging/state.ts", import.meta.url).href;
    const unhandledRejectionsUrl = new URL("../infra/unhandled-rejections.ts", import.meta.url)
      .href;
    const script = `
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      import { loggingState } from ${JSON.stringify(loggingStateUrl)};
      import { installUnhandledRejectionHandler } from ${JSON.stringify(unhandledRejectionsUrl)};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      installUnhandledRejectionHandler();
      defaultRuntime.writeJson({ ok: false });
      const error = Object.assign(new Error("expected fatal test"), {
        code: "ERR_OUT_OF_MEMORY",
      });
      process.emit("unhandledRejection", error, Promise.resolve());
    `;

    const result = runCliChild(script);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: false });
    expect(result.stderr).toContain("\x1b[?25h");
  });
});
