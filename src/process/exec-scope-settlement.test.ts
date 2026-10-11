import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import type { CommandProcessCustody } from "./command-process-custody.types.js";
import { CommandProcessCleanupError, hasCommandProcessCleanupError } from "./exec-result.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";
import { runExec } from "./exec.js";
import { BrokerChild } from "./spawn-broker/child.js";

const transport = vi.hoisted(() => ({ spawn: vi.fn(), settle: vi.fn() }));
vi.mock("execa", () => ({ execa: transport.spawn }));
vi.mock("./windows-command.js", () => ({
  resolveSafeChildProcessInvocation: ({ argv }: { argv: string[] }) => ({
    command: argv[0],
    args: argv.slice(1),
    windowsHide: true,
    windowsVerbatimArguments: false,
    usesWindowsExitCodeShim: false,
  }),
}));
vi.mock("../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: () => 1,
  getProcessInstanceStartTime: () => 1,
}));
vi.mock("./kill-tree.js", () => ({ killProcessTree: vi.fn() }));
vi.mock("./exec-termination.js", () => ({
  createCommandTerminationController: () => ({ terminate: () => false, settle: transport.settle }),
}));

const scopes: Promise<unknown>[] = [];
const fixtures: Array<() => void> = [];
function ownScope<T>(
  run: (stop: () => void) => Promise<T>,
  custody?: CommandProcessCustody,
): Promise<T> {
  const scope = withCommandProcessScope(run, undefined, custody);
  scopes.push(scope);
  void scope.catch(() => {});
  return scope;
}

function commandFixture() {
  const child = new BrokerChild(1, ["fixture"], async () => {});
  const ready = createDeferredCore();
  const closed = createDeferredCore();
  const result = createDeferredCore<{
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number;
    failed: boolean;
    timedOut: boolean;
    isCanceled: boolean;
    isMaxBuffer: boolean;
    isTerminated: boolean;
    isForcefullyTerminated: boolean;
  }>();
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  vi.spyOn(child, "ready").mockReturnValue(ready.promise);
  vi.spyOn(child, "waitForClose").mockReturnValue(closed.promise);
  const command = Object.defineProperties(result.promise, {
    nodeChildProcess: { value: child },
    pid: { get: () => child.pid },
    kill: { value: vi.fn(() => true) },
  });
  transport.spawn.mockReturnValue(command);
  transport.settle.mockReturnValue(cleanup.promise);
  const fixture = {
    child,
    closed,
    cleanup,
    result,
    open() {
      child.pid = 424242;
      ready.resolve();
    },
    finish(close = true) {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      result.resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        failed: false,
        timedOut: false,
        isCanceled: false,
        isMaxBuffer: false,
        isTerminated: false,
        isForcefullyTerminated: false,
      });
      if (close) {
        closed.resolve();
      }
    },
    fail(error: Error) {
      ready.reject(error);
      result.reject(error);
      closed.resolve();
    },
  };
  fixtures.push(() => {
    fixture.open();
    fixture.finish();
    cleanup.resolve("forced");
  });
  return fixture;
}

beforeEach(() => {
  transport.spawn.mockReset();
  transport.settle.mockReset();
  // Synthetic PIDs never reach the operating system.
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("synthetic group has exited"), { code: "ESRCH" });
  });
});
afterEach(async () => {
  for (const dispose of fixtures.splice(0)) {
    dispose();
  }
  await Promise.allSettled(scopes.splice(0));
  vi.restoreAllMocks();
});

describe("command scope physical settlement", () => {
  it.each(["resolved", "rejected"] as const)(
    "inherits custody through native close after %s transport",
    async (result) => {
      const fixture = commandFixture();
      const reservation = { spawned: vi.fn(), settled: vi.fn() };
      const reserve = vi.fn(() => reservation);
      const spawn = transport.spawn.getMockImplementation()!;
      transport.spawn.mockImplementation((...args) => {
        expect(reserve).toHaveBeenCalledExactlyOnceWith(["fixture"]);
        return spawn(...args);
      });
      let finished = false;
      const failure = new Error("transport failed");
      const scope = ownScope(
        () => ownScope(async () => void (await spawnCommand(["fixture"], { reject: false }))),
        { reserve },
      ).finally(() => {
        finished = true;
      });
      const outcome = scope.catch((error: unknown) => error);
      expect(reservation.spawned).not.toHaveBeenCalled();
      fixture.open();
      await setImmediate();
      expect(reservation.spawned).toHaveBeenCalledExactlyOnceWith({ pid: 424242, startedAt: 1 });
      if (result === "rejected") {
        fixture.child.exitCode = 0;
        fixture.child.emit("exit", 0, null);
        fixture.result.reject(failure);
      } else {
        fixture.finish(false);
      }
      await setImmediate();
      expect(finished).toBe(false);
      expect(reservation.settled).not.toHaveBeenCalled();
      fixture.closed.resolve();
      if (result === "rejected") {
        expect(await outcome).toBe(failure);
      } else {
        await scope;
      }
      expect(reservation.settled).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retains unknown broker launches unless non-start is proven: %s",
    async (notStarted) => {
      const fixture = commandFixture();
      const reservation = { spawned: vi.fn(), settled: vi.fn() };
      const scope = ownScope(
        async () => void (await spawnCommand(["fixture"], { reject: false })),
        {
          reserve: () => reservation,
        },
      );
      const outcome = scope.catch((error: unknown) => error);
      if (notStarted) {
        fixture.child.markNotStarted();
      }
      const failure = new Error("broker lost before PID delivery");
      fixture.fail(failure);
      if (notStarted) {
        expect(await outcome).toBe(failure);
      } else {
        expect(await outcome).toMatchObject({
          code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
          cause: failure,
        });
      }
      expect(reservation.spawned).not.toHaveBeenCalled();
      expect(reservation.settled).toHaveBeenCalledTimes(notStarted ? 1 : 0);
    },
  );

  it("refuses Doctor-style input admission when custody binding fails", async () => {
    const fixture = commandFixture();
    fixture.child.stdin = new PassThrough();
    const beforeInput = vi.fn();
    const reservation = {
      spawned: vi.fn(() => {
        throw new Error("custody receipt unavailable");
      }),
      settled: vi.fn(),
    };
    const scope = ownScope(
      async () => {
        await runCommandWithTimeout(["fixture"], { input: "private input", beforeInput });
      },
      { reserve: () => reservation },
    );
    const outcome = scope.catch((error: unknown) => error);
    fixture.open();
    await setImmediate();
    fixture.finish();
    fixture.cleanup.resolve("forced");
    expect(await outcome).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
    expect(beforeInput).not.toHaveBeenCalled();
    expect(reservation.settled).not.toHaveBeenCalled();
  });

  it.each(["forced", "uncertain"] as const)(
    "keeps bounded results pending until %s scope cleanup",
    async (cleanup) => {
      const fixture = commandFixture();
      const controller = new AbortController();
      const resultSeen = createDeferredCore();
      let scopeFinished = false;
      const scope = ownScope(async () => {
        const pending = runCommandWithTimeout(["fixture"], {
          signal: controller.signal,
          killProcessTree: true,
        });
        controller.abort();
        expect(await pending).toMatchObject({ termination: "signal", cleanup: "uncertain" });
        resultSeen.resolve();
      }).finally(() => {
        scopeFinished = true;
      });
      const outcome = scope.catch((error: unknown) => error);
      await resultSeen.promise;
      await setImmediate();
      expect(scopeFinished).toBe(false);
      fixture.open();
      fixture.finish();
      await setImmediate();
      expect(scopeFinished).toBe(false);
      fixture.cleanup.resolve(cleanup);
      if (cleanup === "uncertain") {
        expect(await outcome).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
      } else {
        await scope;
      }
      expect(scopeFinished).toBe(true);
    },
  );

  it.each(["exec", "spawn"] as const)(
    "retains %s admitted before remote readiness",
    async (api) => {
      const fixture = commandFixture();
      const failure = new Error("caller stopped");
      let scopeFinished = false;
      const scope = ownScope(async () => {
        const pending =
          api === "exec"
            ? runExec("fixture", [], { logOutput: false })
            : spawnCommand(["fixture"], { reject: false });
        void pending.catch(() => {});
        throw failure;
      }).finally(() => {
        scopeFinished = true;
      });
      const outcome = scope.catch((error: unknown) => error);
      await setImmediate();
      expect(scopeFinished).toBe(false);
      fixture.open();
      fixture.finish();
      expect(await outcome).toBe(failure);
    },
  );
});

it.skipIf(process.platform === "win32")(
  "preserves uncertainty when a closed raw command still owns a live group",
  async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
    const fixture = commandFixture();
    const scope = ownScope(async () => {
      await spawnCommand(["fixture"], { reject: false });
    });
    const outcome = scope.catch((error: unknown) => error);
    fixture.open();
    fixture.finish();
    try {
      await vi.advanceTimersByTimeAsync(301);
      expect(await outcome).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
    } finally {
      vi.useRealTimers();
    }
  },
);

it("keeps Windows transport failure uncertain without a native exit", async () => {
  await withMockedWindowsPlatform(async () => {
    const fixture = commandFixture();
    const scope = ownScope(async () => {
      const pending = spawnCommand(["fixture"], { reject: false });
      fixture.open();
      await setImmediate();
      fixture.fail(new Error("transport failed after readiness"));
      await pending.catch(() => {});
    });
    const outcome = scope.catch((error: unknown) => error);
    expect(await outcome).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  });
});

it.each(["forced", "uncertain"] as const)(
  "retains an abandoned nested command scope until cleanup reports %s",
  async (cleanupResult) => {
    const fixture = commandFixture();
    const logical = createDeferredCore();
    const finishLogical = createDeferredCore();
    const original = new Error("nested operation cancelled");
    let outerFinished = false;
    const outer = ownScope(async () => {
      void ownScope(async () => {
        const controller = new AbortController();
        const command = runCommandWithTimeout(["fixture"], {
          signal: controller.signal,
          killProcessTree: true,
        });
        controller.abort();
        await command;
        logical.resolve();
        await finishLogical.promise;
        throw original;
      }).catch(() => {});
      return "parent finished its callback";
    }).finally(() => {
      outerFinished = true;
    });
    const outcome = outer.catch((error: unknown) => error);
    try {
      await logical.promise;
      await setImmediate();
      expect(outerFinished).toBe(false);
      fixture.open();
      fixture.finish();
      await setImmediate();
      expect(outerFinished).toBe(false);
      fixture.cleanup.resolve(cleanupResult);
      await setImmediate();
      expect(outerFinished).toBe(true);
      const result = await outcome;
      if (cleanupResult === "uncertain") {
        expect(hasCommandProcessCleanupError(result)).toBe(true);
      } else {
        expect(result).toBe("parent finished its callback");
      }
    } finally {
      finishLogical.resolve();
      await outcome;
    }
  },
);

it("closes nested native admission without waiting for its logical callback", async () => {
  const finishLogical = createDeferredCore();
  let nested: Promise<unknown> | undefined;
  let outerFinished = false;
  const outer = ownScope(async () => {
    nested = ownScope(async () => {
      await finishLogical.promise;
      return await spawnCommand(["fixture"]);
    }).catch((error: unknown) => error);
    return "parent finished";
  }).finally(() => {
    outerFinished = true;
  });
  try {
    await setImmediate();
    expect(outerFinished).toBe(true);
    expect(await outer).toBe("parent finished");
  } finally {
    finishLogical.resolve();
    await Promise.allSettled([outer, nested]);
  }
  expect(await nested).toMatchObject({ message: "Command process scope is closed" });
  expect(transport.spawn).not.toHaveBeenCalled();
});

it("preserves canonical cleanup remedies through nested scopes and module copies", async () => {
  const original = new CommandProcessCleanupError();
  expect(hasCommandProcessCleanupError(new AggregateError([original], "outer"))).toBe(true);
  const unrelated = Object.assign(new Error("private unrelated failure"), { code: original.code });
  expect(hasCommandProcessCleanupError(unrelated)).toBe(false);
  expect(new CommandProcessCleanupError({ cause: unrelated })).toMatchObject({
    message: "Command cleanup could not confirm that owned work stopped",
    cause: unrelated,
  });
  vi.resetModules();
  const duplicate = await import("./exec-result.js");
  const refusal = new duplicate.CommandProcessCleanupError();
  const message =
    "Doctor processes remain unsettled, data-at-risk. PIDs/process groups: 424242; resolve retained process custody before retrying `openclaw update repair`.";
  refusal.message = message;
  const cause = new AggregateError(
    [original, new Error("private wrapper", { cause: refusal })],
    "private aggregate",
    { cause: unrelated },
  );
  const failure = await ownScope(() =>
    ownScope(() =>
      ownScope(async () => {
        throw cause;
      }),
    ),
  ).catch((error: unknown) => error);
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
  expect(failure).toMatchObject({ message, code: original.code, cleanup: "uncertain" });
  expect(collectNestedErrorCandidates(failure)).toContain(cause);
});
