import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
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
vi.mock("../shared/pid-alive.js", () => ({ getFileLockProcessStartTime: () => 1 }));
vi.mock("./kill-tree.js", () => ({ killProcessTree: vi.fn() }));
vi.mock("./exec-termination.js", () => ({
  createCommandTerminationController: () => ({ terminate: () => false, settle: transport.settle }),
}));

const scopes: Promise<unknown>[] = [];
const fixtures: Array<() => void> = [];
function ownScope<T>(run: (stop: () => void) => Promise<T>): Promise<T> {
  const scope = withCommandProcessScope(run);
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
  it("keeps the bounded runner result separate from scope cleanup", async () => {
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
    await resultSeen.promise;
    await setImmediate();
    expect(scopeFinished).toBe(false);
    fixture.open();
    fixture.finish();
    await setImmediate();
    expect(scopeFinished).toBe(false);
    fixture.cleanup.resolve("forced");
    await scope;
    expect(scopeFinished).toBe(true);
  });

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

  it("does not turn cleanup uncertainty into successful scope settlement", async () => {
    const fixture = commandFixture();
    const controller = new AbortController();
    const scope = ownScope(async () => {
      const pending = runCommandWithTimeout(["fixture"], {
        signal: controller.signal,
        killProcessTree: true,
      });
      controller.abort();
      await pending;
    });
    const outcome = scope.catch((error: unknown) => error);
    fixture.open();
    fixture.finish();
    fixture.cleanup.resolve("uncertain");
    expect(await outcome).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  });

  it("does not treat lost transport before PID delivery as non-execution", async () => {
    const fixture = commandFixture();
    const failure = new Error("broker transport lost");
    const scope = ownScope(async () => {
      await spawnCommand(["fixture"], { reject: false });
    });
    const outcome = scope.catch((error: unknown) => error);
    fixture.fail(failure);
    expect(await outcome).toMatchObject({
      code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
      cause: failure,
    });
  });
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

it("joins rejected broker transport through final pipe close", async () => {
  const fixture = commandFixture();
  const failure = new Error("transport failed");
  let finished = false;
  const scope = ownScope(async () => {
    await spawnCommand(["fixture"], { reject: false });
  }).finally(() => {
    finished = true;
  });
  const outcome = scope.catch((error: unknown) => error);
  fixture.open();
  fixture.child.exitCode = 0;
  fixture.child.emit("exit", 0, null);
  fixture.result.reject(failure);
  await setImmediate();
  expect(finished).toBe(false);
  fixture.closed.resolve();
  expect(await outcome).toBe(failure);
});

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

it("recognizes canonical cleanup through aggregates without trusting copied code fields", async () => {
  const original = new CommandProcessCleanupError();
  expect(hasCommandProcessCleanupError(new AggregateError([original], "outer"))).toBe(true);
  expect(
    hasCommandProcessCleanupError(Object.assign(new Error("other"), { code: original.code })),
  ).toBe(false);
  vi.resetModules();
  const duplicate = await import("./exec-result.js");
  expect(hasCommandProcessCleanupError(new duplicate.CommandProcessCleanupError())).toBe(true);
});
