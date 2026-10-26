import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withMockedPlatform, withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import type { CommandProcessCustody } from "./command-process-custody.types.js";
import { CommandProcessCleanupError, hasCommandProcessCleanupError } from "./exec-result.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import {
  COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS,
  spawnCommand,
  withCommandProcessScope,
} from "./exec-spawn.js";
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
// mock-isolation: Synthetic process groups must not leave real reaper work in the shared test worker.
vi.mock("./scoped-child-reaper.js", () => ({ scheduleAdoptedChildZombieReapAfterExit: vi.fn() }));
vi.mock("./exec-termination.js", () => ({
  createCommandTerminationController: () => ({ terminate: () => false, settle: transport.settle }),
}));

const scopes: Promise<unknown>[] = [];
const fixtures: Array<() => void> = [];
const uncertainCleanup = { code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" };
const emptyResult = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  failed: false,
  timedOut: false,
  isCanceled: false,
  isMaxBuffer: false,
  isTerminated: false,
  isForcefullyTerminated: false,
};
const spawnFixture = () => spawnCommand(["fixture"], { reject: false });
async function expectPending(finished: ReturnType<typeof vi.fn>) {
  await setImmediate();
  expect(finished).not.toHaveBeenCalled();
}
function abortCommand() {
  const controller = new AbortController();
  const pending = runCommandWithTimeout(["fixture"], {
    signal: controller.signal,
    killProcessTree: true,
  });
  controller.abort();
  return pending;
}

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
  const result = createDeferredCore<typeof emptyResult>();
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
      result.resolve({ ...emptyResult });
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

it.each(["resolved", "rejected"] as const)(
  "custody survives %s transport until native close",
  async (result) => {
    const fixture = commandFixture();
    const reservation = { spawned: vi.fn(), settled: vi.fn() };
    const reserve = vi.fn(() => reservation);
    const spawn = transport.spawn.getMockImplementation()!;
    transport.spawn.mockImplementation((...args) => {
      expect(reserve).toHaveBeenCalledExactlyOnceWith(["fixture"]);
      return spawn(...args);
    });
    const finished = vi.fn();
    const failure = new Error("transport failed");
    const scope = ownScope(() => ownScope(async () => void (await spawnFixture())), {
      reserve,
    }).finally(finished);
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
    await expectPending(finished);
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

it.each([false, true])("unknown broker launch (proven non-start: %s)", async (notStarted) => {
  const fixture = commandFixture();
  const reservation = { spawned: vi.fn(), settled: vi.fn() };
  const scope = ownScope(async () => void (await spawnFixture()), {
    reserve: () => reservation,
  });
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
});

it.each([false, true])("failed binding withholds input (group live: %s)", async (live) => {
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
  if (live) {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
  }
  fixture.open();
  await setImmediate();
  fixture.finish();
  fixture.cleanup.resolve("forced");
  if (live) {
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS + 1);
    vi.useRealTimers();
  }
  expect(await outcome).toMatchObject(uncertainCleanup);
  expect(beforeInput).not.toHaveBeenCalled();
  expect(reservation.settled).toHaveBeenCalledTimes(live ? 0 : 1);
});

it.each(["forced", "uncertain"] as const)(
  "bounded result waits for %s scope cleanup",
  async (cleanup) => {
    const fixture = commandFixture();
    const resultSeen = createDeferredCore();
    const scopeFinished = vi.fn();
    const scope = ownScope(async () => {
      expect(await abortCommand()).toMatchObject({ termination: "signal", cleanup: "uncertain" });
      resultSeen.resolve();
    }).finally(scopeFinished);
    const outcome = scope.catch((error: unknown) => error);
    await resultSeen.promise;
    await expectPending(scopeFinished);
    fixture.open();
    fixture.finish();
    await expectPending(scopeFinished);
    fixture.cleanup.resolve(cleanup);
    if (cleanup === "uncertain") {
      expect(await outcome).toMatchObject(uncertainCleanup);
    } else {
      await scope;
    }
    expect(scopeFinished).toHaveBeenCalledOnce();
  },
);

it.each(["exec", "spawn"] as const)("retains %s admitted before remote readiness", async (api) => {
  const fixture = commandFixture();
  const failure = new Error("caller stopped");
  const scopeFinished = vi.fn();
  const scope = ownScope(async () => {
    const pending = api === "exec" ? runExec("fixture", [], { logOutput: false }) : spawnFixture();
    void pending.catch(() => {});
    throw failure;
  }).finally(scopeFinished);
  const outcome = scope.catch((error: unknown) => error);
  await expectPending(scopeFinished);
  fixture.open();
  fixture.finish();
  expect(await outcome).toBe(failure);
});

it.skipIf(process.platform === "win32").each([false, true])(
  "closed raw command waits for group extinction (exits: %s)",
  (exits) =>
    withMockedPlatform("linux", async () => {
      const listeners = process.listeners("SIGCHLD");
      vi.useFakeTimers();
      const disappearsAt = Date.now() + 1_000;
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (!exits) {
          return true;
        }
        throw Object.assign(new Error("synthetic group probe"), {
          code: Date.now() < disappearsAt ? "EPERM" : "ESRCH",
        });
      });
      const fixture = commandFixture();
      const reservation = { spawned: vi.fn(), settled: vi.fn() };
      const scope = ownScope(
        async () => void (await spawnFixture()),
        exits ? { reserve: () => reservation } : undefined,
      );
      const outcome = scope.catch((error: unknown) => error);
      fixture.open();
      fixture.finish();
      try {
        if (exits) {
          await vi.advanceTimersByTimeAsync(999);
          expect(reservation.settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await expect(scope).resolves.toBeUndefined();
          expect(reservation.settled).toHaveBeenCalledOnce();
        } else {
          await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS + 1);
          expect(await outcome).toMatchObject(uncertainCleanup);
        }
        expect(process.listeners("SIGCHLD")).toEqual(listeners);
      } finally {
        vi.useRealTimers();
      }
    }),
);

it("keeps Windows transport failure uncertain without a native exit", async () => {
  await withMockedWindowsPlatform(async () => {
    const fixture = commandFixture();
    const scope = ownScope(async () => {
      const pending = spawnFixture();
      fixture.open();
      await setImmediate();
      fixture.fail(new Error("transport failed after readiness"));
      await pending.catch(() => {});
    });
    const outcome = scope.catch((error: unknown) => error);
    expect(await outcome).toMatchObject(uncertainCleanup);
  });
});

it.each(["forced", "uncertain"] as const)(
  "retains an abandoned nested command scope until cleanup reports %s",
  async (cleanupResult) => {
    const fixture = commandFixture();
    const logical = createDeferredCore();
    const finishLogical = createDeferredCore();
    const original = new Error("nested operation cancelled");
    const outerFinished = vi.fn();
    const outer = ownScope(async () => {
      void ownScope(async () => {
        await abortCommand();
        logical.resolve();
        await finishLogical.promise;
        throw original;
      }).catch(() => {});
      return "parent finished its callback";
    }).finally(outerFinished);
    const outcome = outer.catch((error: unknown) => error);
    try {
      await logical.promise;
      await expectPending(outerFinished);
      fixture.open();
      fixture.finish();
      await expectPending(outerFinished);
      fixture.cleanup.resolve(cleanupResult);
      await setImmediate();
      expect(outerFinished).toHaveBeenCalledOnce();
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
  const outerFinished = vi.fn();
  const outer = ownScope(async () => {
    nested = ownScope(async () => {
      await finishLogical.promise;
      return await spawnCommand(["fixture"]);
    }).catch((error: unknown) => error);
    return "parent finished";
  }).finally(outerFinished);
  try {
    await setImmediate();
    expect(outerFinished).toHaveBeenCalledOnce();
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
