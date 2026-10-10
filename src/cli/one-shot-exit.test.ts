import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import {
  exitCliAfterOutput,
  requestExitAfterOneShotOutput,
  runCliWithExitFinalization,
} from "./one-shot-exit.js";
import {
  exitAfterSignalExitBarriers,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "./signal-exit-barrier.js";

const successfulRun = async () => {};
const ignoreError = () => {};
const proxyChildTempDir = useAutoCleanupTempDirTracker(afterAll).make("openclaw-proxy-child-tmp-");

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

describe("one-shot CLI completion", () => {
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it.each(["default", "injected"])("unwinds the %s runtime with its requested code", (kind) => {
    const exit = vi.fn();
    const runtime = kind === "default" ? defaultRuntime : { ...defaultRuntime, exit };
    let thrown: unknown;
    try {
      exitCliAfterOutput(runtime, 7);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExitError);
    expect(thrown).toMatchObject({ code: 7 });
    if (kind === "injected") {
      expect(exit).toHaveBeenCalledExactlyOnceWith(7);
    }
  });

  it("preserves errors thrown by an injected runtime exit", () => {
    const failure = new Error("embedded runtime stopped");
    const runtime = {
      ...defaultRuntime,
      exit: vi.fn(() => {
        throw failure;
      }),
    };
    expect(() => exitCliAfterOutput(runtime, 7)).toThrow(failure);
  });

  it.each([
    { outcome: "deferred exit", commandExit: 7, cleanupFails: false },
    { outcome: "deferred exit with failed cleanup", commandExit: 7, cleanupFails: true },
    { outcome: "cleanup failure after success", commandExit: undefined, cleanupFails: true },
    {
      outcome: "deferred exit with failed reporter",
      commandExit: 7,
      cleanupFails: true,
      reporterRethrows: true,
    },
  ])(
    "leaves $outcome owned by the injected runtime",
    async ({ commandExit, cleanupFails, reporterRethrows }) => {
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
            if (cleanupFails) {
              throw cleanupFailure;
            }
          },
          onError,
          runtime,
        }),
      ).rejects.toBe(commandFailure ?? cleanupFailure);
      if (cleanupFails) {
        expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupFailure);
      } else {
        expect(onError).not.toHaveBeenCalled();
      }
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("does not finalize a long-lived command until its run settles", async () => {
    const finish = createDeferred();
    const finalize = vi.fn(async () => {});
    const running = runCliWithExitFinalization({
      run: () => finish.promise,
      finalize,
      onError: ignoreError,
    });
    requestExitAfterOneShotOutput(defaultRuntime, 7);
    await Promise.resolve();
    expect(finalize).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    finish.resolve();
    await running;
    expect(finalize).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(7);
  });

  it.each([
    { requested: 0, signal: "SIGTERM" as const, expected: 143 },
    { requested: "0", signal: "SIGINT" as const, expected: 130 },
    { requested: 7, signal: "SIGTERM" as const, expected: 7 },
  ])(
    "retains an accepted signal over pending success ($requested, $signal)",
    async ({ requested, signal, expected }) => {
      const cleanup = createDeferred();
      const unregister = registerSignalExitGate(cleanup.promise);
      const finalize = vi.fn(async () => {});
      exitAfterSignalExitBarriers(requested);
      const signalDrain = waitForSignalExitBarriers(signal);
      const completing = runCliWithExitFinalization({
        run: successfulRun,
        onError: ignoreError,
        finalize,
      });
      try {
        await Promise.resolve();
        expect(finalize).not.toHaveBeenCalled();
        cleanup.resolve();
        await Promise.all([signalDrain, completing]);
        expect(process.exitCode).toBe(expected);
        expect(finalize).toHaveBeenCalledOnce();
      } finally {
        cleanup.resolve();
        await Promise.all([signalDrain, completing]);
        unregister();
      }
    },
  );

  it("joins caller-owned cleanup before publishing completion", async () => {
    const closed = createDeferred();
    const entered = createDeferred();
    const running = runCliWithExitFinalization({
      run: async () => {
        throw new ExitError(7);
      },
      finalize: async () => {
        entered.resolve();
        await closed.promise;
      },
      onError: ignoreError,
    });
    try {
      await entered.promise;
      expect(process.exitCode).toBeUndefined();
    } finally {
      closed.resolve();
      await running;
    }
    expect(process.exitCode).toBe(7);
  });

  it("reports failure before replacing a queued successful outcome", async () => {
    const order: string[] = [];
    requestExitAfterOneShotOutput(defaultRuntime, 0);
    await runCliWithExitFinalization({
      run: async () => {
        throw new Error("command failed");
      },
      onError: async () => {
        await Promise.resolve();
        order.push("reported");
        process.exitCode = 6;
      },
      finalize: async () => {
        order.push("closed");
      },
    });
    expect(order).toEqual(["reported", "closed"]);
    expect(process.exitCode).toBe(6);
  });

  it.each([
    { recorded: undefined, expected: 0 },
    { recorded: 1, expected: 1 },
    { recorded: "9", expected: 9 },
  ])("preserves recorded outcome $recorded", async ({ recorded, expected }) => {
    await runCliWithExitFinalization({
      run: async () => {
        requestExitAfterOneShotOutput();
        process.exitCode = recorded;
      },
      onError: ignoreError,
    });
    expect(process.exitCode).toBe(expected);
  });

  it.each([0, 7])("preserves explicit command outcome %i", async (code) => {
    process.exitCode = 9;
    requestExitAfterOneShotOutput(defaultRuntime, code);
    await runCliWithExitFinalization({ run: successfulRun, onError: ignoreError });
    expect(process.exitCode).toBe(code);
  });

  it.each(["before cleanup", "during cleanup"])(
    "retains terminal signal outcome %s",
    async (phase) => {
      await runCliWithExitFinalization({
        run: async () => {
          requestExitAfterOneShotOutput(defaultRuntime, 0);
          if (phase === "before cleanup") {
            exitAfterSignalExitBarriers(143);
          }
        },
        finalize: async () => {
          if (phase === "during cleanup") {
            exitAfterSignalExitBarriers(143);
          }
        },
        onError: ignoreError,
      });
      expect(process.exitCode).toBe(143);
    },
  );

  it("does not record an outcome for an embedded custom runtime", async () => {
    process.exitCode = 4;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    expect(requestExitAfterOneShotOutput(runtime, 7)).toBe(false);
    await runCliWithExitFinalization({ run: successfulRun, onError: ignoreError, runtime });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(4);
  });

  it.each(["requested nonzero exit", "deferred ExitError"])(
    "drains large piped JSON before a %s without reporting another error",
    (exitMode) => {
      const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
      const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
      const payloadBytes = 1024 * 1024;
      const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime, ExitError } from ${JSON.stringify(runtimeUrl)};
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeJson({ ok: false, payload: "x".repeat(${payloadBytes}) });
          ${exitMode === "deferred ExitError" ? "throw new ExitError(7);" : "requestExitAfterOneShotOutput(defaultRuntime, 7);"}
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
    },
  );

  it.each([
    {
      name: "long help spelling consumed as a proxy URL",
      args: ["--proxy-url", "--help", "--json"],
      exitCode: 1,
      failure: true,
    },
    {
      name: "short help spelling consumed as a proxy URL",
      args: ["--proxy-url", "-h", "--json"],
      exitCode: 1,
      failure: true,
    },
    {
      name: "genuine command help after a boolean option",
      args: ["--json", "--help"],
      exitCode: 0,
      failure: false,
    },
  ])("keeps the real proxy command exit truthful for $name", ({ args, exitCode, failure }) => {
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
      const argv = ["node", "openclaw", "proxy", "validate", ...${JSON.stringify(args)}];
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
    expect(result.status).toBe(exitCode);
    if (failure) {
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          config: expect.objectContaining({
            errors: ["proxyUrl must use http:// or https://"],
          }),
        }),
      );
    } else {
      expect(result.stdout).toContain("Usage: openclaw proxy validate");
    }
  });

  it.each([
    { name: "deferred hooks failure", exitCode: 1, explicitRequest: true },
    { name: "natural successful completion", exitCode: 0, explicitRequest: false },
  ])("keeps real dual-TTY JSON clean for $name", ({ exitCode, explicitRequest }) => {
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
          defaultRuntime.writeStdout(JSON.stringify({ ok: ${exitCode === 0} }));
          ${explicitRequest ? `requestExitAfterOneShotOutput(defaultRuntime, ${exitCode});` : ""}
        },
        onError: (error) => { throw error; },
      });
    `;

    const result = runCliChild(script);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: exitCode === 0 });
    expect(result.stderr).toContain("\x1b[?25h");
  });

  it.each([
    { name: "fatal unhandled rejection", errorCode: "ERR_OUT_OF_MEMORY", exitCode: 1 },
    { name: "invalid configuration rejection", errorCode: "INVALID_CONFIG", exitCode: 78 },
  ])("keeps real dual-TTY JSON clean after $name", ({ errorCode, exitCode }) => {
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
        code: ${JSON.stringify(errorCode)},
      });
      process.emit("unhandledRejection", error, Promise.resolve());
    `;

    const result = runCliChild(script);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: false });
    expect(result.stderr).toContain("\x1b[?25h");
  });
});
