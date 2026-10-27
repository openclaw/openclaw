import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext as withTrace,
} from "../infra/diagnostic-trace-context.js";
import { runWithSqliteDatabaseAdmissionTurn as nativeTurn } from "../infra/sqlite-database-admission-turn.js";
import { withSqliteDatabaseAdmissionExchange as withExchange } from "../infra/sqlite-database-admission.js";
import { withSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import { trackWorkerRequest } from "../infra/worker-request-diagnostics.js";
import * as logging from "../logging/logger.js";
import {
  runOpenClawAgentWorkerWrite as workerWrite,
  runOpenClawAgentBoardReadAdmission as boardRead,
  runOpenClawAgentPathWriteAdmission as pathWrite,
  runOpenClawAgentWriteAdmission as write,
  runOpenClawAgentWriteAdmissions as writeMany,
} from "./openclaw-agent-write-admission.js";

const slowMessage = "slow agent database reservation";
function warning(fields: Record<string, unknown>) {
  return [expect.objectContaining(fields), slowMessage];
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function makeFixture(agentId = "usage", filename = "agent.sqlite") {
  const root = tempDirs.make("agent-admission-");
  const options = { agentId, path: path.join(root, filename) };
  const entered = createDeferred();
  const release = createDeferred();
  const order: string[] = [];
  const hold = () => {
    entered.resolve();
    return release.promise;
  };
  const record = (value: string) => async () => {
    order.push(value);
  };
  return { root, options, entered, release, order, hold, record };
}

it("overlaps Board reads with transcript writes while retaining exclusive mutation order", async ({
  signal,
}) => {
  const { options, order, record } = makeFixture("main");
  const writerEntered = createDeferred();
  const releaseWriter = createDeferred();
  const readEntered = createDeferred();
  const releaseRead = createDeferred();
  const writer = workerWrite(
    options,
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
      order.push("transcript");
    },
    undefined,
    undefined,
    undefined,
    undefined,
    "transcript-only",
  );
  await writerEntered.promise;
  const read = boardRead(options, async () => {
    readEntered.resolve();
    await releaseRead.promise;
    order.push("read");
  });
  const mutation = workerWrite(options, record("mutation settled"));
  const following = boardRead(options, record("following read"));
  try {
    await withinTest(readEntered.promise, signal);
    releaseWriter.resolve();
    await writer;
    expect(order).toEqual(["transcript"]);
    releaseRead.resolve();
    await Promise.all([read, mutation, following]);
    expect(order).toEqual(["transcript", "read", "mutation settled", "following read"]);
  } finally {
    releaseWriter.resolve();
    releaseRead.resolve();
    await Promise.allSettled([writer, read, mutation, following]);
  }
});

it.each(["single", "batch"] as const)(
  "lets a cold native task finish its background write before a %s foreground reservation",
  async (kind) =>
    withExchange(
      () => [],
      async () => {
        const { root, options, entered, order, record } = makeFixture("usage", "z/agent.sqlite");
        const earlier = { agentId: "earlier", path: path.join(root, "a", "agent.sqlite") };
        const requestPrune = createDeferred();
        const releaseTurn = createDeferred();
        let pruning: Promise<void> | undefined;
        const native = nativeTurn([options.path], async () => {
          entered.resolve();
          await requestPrune.promise;
          pruning = workerWrite(options, record("prune"), undefined, undefined, "background");
          // Let failure cleanup release the synthetic turn without stranding the FIFO.
          await Promise.race([pruning, releaseTurn.promise]);
        });
        await entered.promise;
        let foregroundEntered = false;
        const prepare = () => {
          foregroundEntered = true;
          return nativeTurn([options.path], record("foreground"));
        };
        const foreground =
          kind === "single" ? write(options, prepare) : writeMany([earlier, options], prepare);
        try {
          await Promise.resolve();
          expect(foregroundEntered).toBe(false);
          requestPrune.resolve();
          await Promise.all([native, foreground]);
          expect(order).toEqual(["prune", "foreground"]);
        } finally {
          releaseTurn.resolve();
          requestPrune.resolve();
          await Promise.allSettled([native, foreground]);
          await pruning;
        }
      },
    ),
);

it.each([false, true])(
  "defers background writes behind later foreground work (abort=%s)",
  async (abort) => {
    const { options, entered, release, order, hold, record } = makeFixture();
    const controller = new AbortController();
    const reason = new Error("closed");
    const held = workerWrite(options, async () => {
      order.push("held");
      await hold();
    });
    await entered.promise;
    const background = workerWrite(
      options,
      record("background"),
      undefined,
      controller.signal,
      "background",
    );
    const foreground = workerWrite(options, record("foreground"));
    const outcome = abort ? expect(background).rejects.toBe(reason) : background;
    try {
      if (abort) {
        controller.abort(reason);
      }
      release.resolve();
      await Promise.all([held, foreground, outcome]);
      expect(order).toEqual(abort ? ["held", "foreground"] : ["held", "foreground", "background"]);
    } finally {
      release.resolve();
      await Promise.allSettled([held, foreground, background]);
    }
  },
);

it.each(["write", "replace", "remove"] as const)(
  "revalidates the captured file after an awaited %s",
  async (change) => {
    const root = tempDirs.make("openclaw-write-identity-");
    const pathname = path.join(root, "agent.sqlite");
    fs.writeFileSync(pathname, "original");
    await pathWrite(pathname, async (_identity, assertCurrent) => {
      await Promise.resolve();
      if (change === "write") {
        fs.writeFileSync(pathname, "updated");
        expect(assertCurrent).not.toThrow();
      } else if (change === "replace") {
        const replacement = path.join(root, "replacement.sqlite");
        fs.writeFileSync(replacement, "replacement");
        fs.renameSync(replacement, pathname);
        expect(assertCurrent).toThrow("database target changed");
      } else {
        fs.unlinkSync(pathname);
        expect(assertCurrent).toThrow();
      }
    });
  },
);

it("keeps a missing reservation current when its database is created", async () => {
  const pathname = path.join(tempDirs.make("openclaw-write-create-"), "agent.sqlite");
  await pathWrite(pathname, async (_identity, assertCurrent) => {
    await Promise.resolve();
    fs.writeFileSync(pathname, "created");
    expect(assertCurrent).not.toThrow();
  });
});

it.each(["symlink", "hardlink"] as const)(
  "borrows one foreground admission for %s aliases without admitting a worker reservation",
  async (kind) => {
    const { options, root } = makeFixture();
    fs.writeFileSync(options.path, "database");
    const aliasDirectory = path.join(root, "alias");
    const alias = {
      ...options,
      path:
        kind === "symlink"
          ? path.join(aliasDirectory, path.basename(options.path))
          : path.join(root, "alias.sqlite"),
    };
    if (kind === "symlink") {
      fs.symlinkSync(root, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.linkSync(options.path, alias.path);
    }
    await write(options, async () => {
      expect(await writeMany([alias, options], () => "read complete")).toBe("read complete");
    });
    await workerWrite(options, async () => {
      await expect(writeMany([alias, options], () => "unsafe read")).rejects.toThrow(
        "cannot reenter an active SQLite writer admission",
      );
    });
    const distinct = { ...options, path: path.join(root, "distinct.sqlite") };
    fs.writeFileSync(distinct.path, "other database");
    await write(options, async () => {
      await expect(writeMany([options, distinct], () => "unsafe read")).rejects.toThrow(
        "cannot reenter an active SQLite writer admission",
      );
    });
  },
);

it.each([
  { count: 773, outcome: "ok" },
  { count: 5_000, outcome: "error" },
] as const)(
  "reserves $count agents without overflowing and preserves $outcome settlement",
  async ({ count, outcome }) => {
    const root = tempDirs.make("openclaw-fleet-admission-");
    const options = Array.from({ length: count }, (_, index) => ({
      agentId: `agent-${index}`,
      path: path.join(root, `${String(index).padStart(4, "0")}.sqlite`),
    }));
    const first = expectDefined(options[0], "first database");
    const last = expectDefined(options.at(-1), "last database");
    const caller = new AsyncLocalStorage<string>();
    const entered = createDeferred();
    const release = createDeferred();
    const failure = new Error("fleet read failed");
    const order: string[] = [];
    const batch = caller.run("fleet-reader", () =>
      writeMany(options, async () => {
        expect(caller.getStore()).toBe("fleet-reader");
        await write(first, () => order.push("reentrant"), true);
        entered.resolve();
        await release.promise;
        order.push("settled");
        if (outcome === "error") {
          throw failure;
        }
        return "read complete";
      }),
    );
    const observed = batch.then(
      (value) => value,
      (error: unknown) => error,
    );
    const follower = write(last, () => order.push("follower"));
    try {
      await awaitGateBeforeSettlement(entered.promise, batch, "Fleet read did not enter");
      expect(order).toEqual(["reentrant"]);
      release.resolve();
      expect(await observed).toBe(outcome === "error" ? failure : "read complete");
      await follower;
      expect(order).toEqual(["reentrant", "settled", "follower"]);
    } finally {
      release.resolve();
      await Promise.allSettled([batch, follower]);
    }
  },
);

it("releases earlier reservations when a later database path is invalid", async () => {
  const root = tempDirs.make("openclaw-partial-admission-");
  const first = { agentId: "first", path: path.join(root, "a.sqlite") };
  const invalid = { agentId: "invalid", path: path.join(root, "z.sqlite") };
  fs.mkdirSync(invalid.path);
  const run = vi.fn();
  const batch = writeMany([first, invalid], run);
  const rejected = expect(batch).rejects.toThrow("must identify a regular file");
  const follower = write(first, () => "released");
  await rejected;
  expect(run).not.toHaveBeenCalled();
  expect(await follower).toBe("released");
});

it.each(["worker", "multiple stores"] as const)(
  "identifies the inherited %s admission when refusing a nested session read",
  async (kind) => {
    const { options } = makeFixture(
      "usage",
      path.join(...Array.from({ length: 12 }, () => "long-directory"), "agent.sqlite"),
    );
    const second = { ...options, path: path.join(path.dirname(options.path), "second.sqlite") };
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const consume = vi.fn();
    const run = async () => {
      const request = trackWorkerRequest("sqlite_writer", "session.entry.patch.commit");
      request.started();
      const privateRequest = trackWorkerRequest("sqlite_writer", "private-command-payload");
      privateRequest.started();
      await Promise.resolve();
      now = 350;
      const error = await writeMany(
        kind === "worker" ? [options] : [options, second],
        consume,
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        "Session read batch cannot reenter an active SQLite writer admission",
      );
      const fields: unknown = JSON.parse(String(error).slice(String(error).indexOf("{")));
      expect(fields).toMatchObject({
        operation: kind === "worker" ? "worker" : "direct",
        ageMs: 250,
        threadId,
        isMainThread,
        database: expect.stringContaining("agent.sqlite"),
        ...(kind === "worker"
          ? { workerOperations: ["session.entry.patch.commit", "other"] }
          : { caller: "session-manager.write" }),
      });
      expect(String(error)).not.toContain(path.dirname(options.path));
      expect(String(error).length).toBeLessThan(600);
      expect(String(error)).not.toContain("private-command-payload");
      expect(consume).not.toHaveBeenCalled();
      request.completed();
      privateRequest.completed();
    };
    if (kind === "worker") {
      await workerWrite(options, run);
    } else {
      await write(options, run, false, undefined, undefined, "session-manager.write");
    }
    await expect(writeMany([options], () => "released")).resolves.toBe("released");
  },
);

function fixture() {
  const base = makeFixture("synthetic-private-agent", "private.sqlite");
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const warnings: unknown[][] = [];
  const getChildLogger = logging.getChildLogger;
  vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
    const logger = getChildLogger(...args);
    vi.spyOn(logger, "warn").mockImplementation((...values) => {
      warnings.push(values);
      return undefined;
    });
    return logger;
  });
  return { ...base, clock, warnings };
}

it.each([
  ["direct", "ok"],
  ["direct", "error"],
  ["worker", "error"],
] as const)(
  "reports the slow %s holder and queued follower after %s settlement",
  async (kind, outcome) => {
    const { options, clock, warnings, entered, release, order, hold } = fixture();
    const releaseFollower = createDeferred();
    const failure = new Error("synthetic-private-error");
    const value = { result: "synthetic-private-result" };
    const controller = new AbortController();
    const reserve = (run: () => Promise<typeof value>, holder = false) =>
      kind === "worker"
        ? workerWrite(options, run, undefined, holder ? controller.signal : undefined)
        : write(
            options,
            run,
            false,
            undefined,
            undefined,
            holder ? "session-manager.write" : undefined,
          );
    const observations: unknown[] = [];
    const diagnostics = channel("openclaw.agent-database.reservation");
    const observe = (observation: unknown) => {
      observations.push(observation);
    };
    diagnostics.subscribe(observe);
    const first = withSqliteReaderOwner(
      { operation: "synthetic-private-operation", ownerKind: "main" },
      () =>
        reserve(async () => {
          order.push("holder");
          await hold();
          if (kind === "worker") {
            const request = trackWorkerRequest("sqlite_writer", "session.entry.patch.commit");
            request.started();
            request.completed();
            controller.signal.throwIfAborted();
          }
          if (outcome === "error") {
            throw failure;
          }
          return value;
        }, true),
    );
    const settled = first.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    clock.now = 100;
    const next = reserve(async () => {
      order.push("follower");
      // The holder's diagnostic continuation may run after the follower starts.
      await releaseFollower.promise;
      clock.now += 25;
      return value;
    });
    try {
      if (kind === "worker") {
        controller.abort(failure);
      }
      expect(order).toEqual(["holder"]);
      clock.now = 1_600;
      release.resolve();
      const observed = await settled;
      expect("error" in observed ? observed.error : observed.result).toBe(
        outcome === "error" ? failure : value,
      );
      releaseFollower.resolve();
      expect(await next).toBe(value);
      expect(order).toEqual(["holder", "follower"]);
      expect(warnings).toEqual([
        warning({
          operation: kind,
          outcome,
          writerExecutionMs: 1_600,
          reentrant: false,
          ...(kind === "direct" ? { caller: "session-manager.write" } : {}),
        }),
        warning({
          operation: kind,
          outcome: "ok",
          queueWaitMs: 1_500,
          writerExecutionMs: 25,
          blockingOperation: kind,
          ...(kind === "direct"
            ? { blockingCaller: "session-manager.write" }
            : { blockingWorkerOperations: ["session.entry.patch.commit"] }),
        }),
      ]);
      expect(JSON.stringify(warnings)).not.toContain("synthetic-private");
      expect(JSON.stringify(warnings)).not.toContain(options.path);
      expect(observations).toEqual([
        warnings[0]![0],
        expect.objectContaining({ operation: kind, writerExecutionMs: 25 }),
      ]);
      expect(JSON.stringify(observations)).not.toContain("synthetic-private");
    } finally {
      release.resolve();
      releaseFollower.resolve();
      await Promise.allSettled([first, next]);
      diagnostics.unsubscribe(observe);
    }
  },
);

it("attributes a reentrant Worker reservation without letting foreground callbacks borrow it", async () => {
  const { options, clock, warnings, order } = fixture();
  let follower: Promise<void> | undefined;
  await write(options, async () => {
    await workerWrite(options, async () => {
      follower = write(
        options,
        () => {
          order.push("follower");
        },
        true,
      );
      const request = trackWorkerRequest("sqlite_writer", "session.entry.patch.commit");
      request.started();
      clock.now = 1_000;
      request.completed();
      await Promise.resolve();
      order.push("worker settled");
    });
    order.push("holder settled");
  });
  await follower;
  expect(order).toEqual(["worker settled", "holder settled", "follower"]);
  expect(warnings.at(-1)).toEqual(
    warning({
      queueWaitMs: 1_000,
      writerExecutionMs: 0,
      blockingOperation: "worker",
      blockingWorkerOperations: ["session.entry.patch.commit"],
    }),
  );
});

it("reports each ordered-read reservation across an awaited read without reporting reentrant borrowing", async () => {
  const { options, clock, warnings, entered, release, hold } = fixture();
  const second = { ...options, path: path.join(path.dirname(options.path), "second.sqlite") };
  const read = writeMany([second, options], async () => {
    await hold();
    await write(
      options,
      () => {
        clock.now = 1_200;
      },
      true,
    );
  });
  try {
    await awaitGateBeforeSettlement(entered.promise, read, "Ordered read did not enter");
    clock.now = 100;
    release.resolve();
    await read;
    const expected = warning({
      operation: "ordered-read",
      outcome: "ok",
      writerExecutionMs: 1_200,
      reentrant: false,
    });
    expect(warnings).toEqual([expected, expected]);
  } finally {
    release.resolve();
    await read;
  }
});

it("does not report a cancelled waiter as a holder", async () =>
  withExchange(
    () => [],
    async () => {
      const { options, clock, warnings, entered, release, hold } = fixture();
      const first = write(options, hold);
      await entered.promise;
      const controller = new AbortController();
      const callback = vi.fn(async () => {});
      const waiting = write(options, callback, false, undefined, controller.signal);
      const reason = new Error("cancel waiting reservation");
      const nativeCallback = vi.fn(async () => {});
      let successor: Promise<void> | undefined;
      try {
        clock.now = 1_500;
        controller.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        expect(callback).not.toHaveBeenCalled();
        expect(warnings).toEqual([]);
        successor = nativeTurn([options.path], nativeCallback);
        await Promise.resolve();
        expect(nativeCallback).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([first, waiting, successor]);
      }
      expect(nativeCallback).toHaveBeenCalledOnce();
    },
  ));

it.each(["ok", "error"] as const)(
  "preserves %s settlement when slow-path logging fails",
  async (outcome) => {
    const { options, clock } = fixture();
    vi.mocked(logging.getChildLogger).mockImplementation(() => {
      throw new Error("logger failed");
    });
    const result = {};
    const pending = write(options, () => {
      clock.now = 1_100;
      if (outcome === "error") {
        // oxlint-disable-next-line typescript/only-throw-error -- Diagnostics must preserve non-Error rejection identity.
        throw result;
      }
      return result;
    });
    if (outcome === "error") {
      await expect(pending).rejects.toBe(result);
    } else {
      await expect(pending).resolves.toBe(result);
    }
  },
);

it("delivers reservation timing and request trace through the diagnostic log transport", async () => {
  const { options, clock } = fixture();
  vi.mocked(logging.getChildLogger).mockRestore();
  resetDiagnosticEventsForTest();
  logging.resetLogger();
  logging.setLoggerOverride({ level: "warn", file: `${options.path}.log` });
  const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "log.record") {
      received.push(event);
    }
  });
  const trace = createDiagnosticTraceContext();
  try {
    await withTrace(trace, () =>
      write(options, () => {
        clock.now = 1_250;
      }),
    );
    await waitForDiagnosticEventsDrained();
    expect(received).toEqual([
      expect.objectContaining({
        message: slowMessage,
        level: "WARN",
        trace,
        attributes: expect.objectContaining({
          subsystem: "session-sqlite",
          writerExecutionMs: 1_250,
        }),
      }),
    ]);
  } finally {
    unsubscribe();
    await logging.flushLogger();
    logging.setLoggerOverride(null);
    logging.resetLogger();
    resetDiagnosticEventsForTest();
  }
});
