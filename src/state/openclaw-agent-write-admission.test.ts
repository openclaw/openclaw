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
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../infra/sqlite-database-admission-turn.js";
import { withSqliteDatabaseAdmissionExchange } from "../infra/sqlite-database-admission.js";
import { withSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import { trackWorkerRequest } from "../infra/worker-request-diagnostics.js";
import * as logging from "../logging/logger.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentBoardReadAdmission,
  runOpenClawAgentPathWriteAdmission,
  runOpenClawAgentWriteAdmission,
  runOpenClawAgentWriteAdmissions,
} from "./openclaw-agent-write-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("overlaps Board reads with transcript writes while retaining exclusive mutation order", async ({
  signal,
}) => {
  const options = {
    agentId: "main",
    path: path.join(tempDirs.make("board-admission-"), "agent.sqlite"),
  };
  const writerEntered = createDeferred();
  const releaseWriter = createDeferred();
  const readEntered = createDeferred();
  const releaseRead = createDeferred();
  const order: string[] = [];
  const writer = runOpenClawAgentWorkerWrite(
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
  const read = runOpenClawAgentBoardReadAdmission(options, async () => {
    readEntered.resolve();
    await releaseRead.promise;
    order.push("read");
  });
  const mutation = runOpenClawAgentWorkerWrite(options, async () => {
    order.push("mutation settled");
  });
  const following = runOpenClawAgentBoardReadAdmission(options, async () => {
    order.push("following read");
  });
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
    withSqliteDatabaseAdmissionExchange(
      () => [],
      async () => {
        const root = tempDirs.make("openclaw-cold-writer-order-");
        const options = { agentId: "usage", path: path.join(root, "z", "agent.sqlite") };
        const earlier = { agentId: "earlier", path: path.join(root, "a", "agent.sqlite") };
        const entered = createDeferred();
        const requestPrune = createDeferred();
        const releaseTurn = createDeferred();
        const order: string[] = [];
        let pruning: Promise<void> | undefined;
        const native = runWithSqliteDatabaseAdmissionTurn([options.path], async () => {
          entered.resolve();
          await requestPrune.promise;
          pruning = runOpenClawAgentWorkerWrite(
            options,
            async () => {
              order.push("prune");
            },
            undefined,
            undefined,
            "background",
          );
          // Let failure cleanup release the synthetic turn without stranding the FIFO.
          await Promise.race([pruning, releaseTurn.promise]);
        });
        await entered.promise;
        let foregroundEntered = false;
        const prepare = () => {
          foregroundEntered = true;
          return runWithSqliteDatabaseAdmissionTurn([options.path], async () => {
            order.push("foreground");
          });
        };
        const foreground =
          kind === "single"
            ? runOpenClawAgentWriteAdmission(options, prepare)
            : runOpenClawAgentWriteAdmissions([earlier, options], prepare);
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
    const root = tempDirs.make("openclaw-background-admission-");
    const options = { agentId: "usage", path: path.join(root, "agent.sqlite") };
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    const reason = new Error("closed");
    const order: string[] = [];
    const held = runOpenClawAgentWorkerWrite(options, async () => {
      order.push("held");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const background = runOpenClawAgentWorkerWrite(
      options,
      async () => {
        order.push("background");
      },
      undefined,
      controller.signal,
      "background",
    );
    const foreground = runOpenClawAgentWorkerWrite(options, async () => {
      order.push("foreground");
    });
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
    await runOpenClawAgentPathWriteAdmission(pathname, async (_identity, assertCurrent) => {
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
  await runOpenClawAgentPathWriteAdmission(pathname, async (_identity, assertCurrent) => {
    await Promise.resolve();
    fs.writeFileSync(pathname, "created");
    expect(assertCurrent).not.toThrow();
  });
});

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
      runOpenClawAgentWriteAdmissions(options, async () => {
        expect(caller.getStore()).toBe("fleet-reader");
        await runOpenClawAgentWriteAdmission(first, () => order.push("reentrant"), true);
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
    const follower = runOpenClawAgentWriteAdmission(last, () => order.push("follower"));
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
  const batch = runOpenClawAgentWriteAdmissions([first, invalid], run);
  const rejected = expect(batch).rejects.toThrow("must identify a regular file");
  const follower = runOpenClawAgentWriteAdmission(first, () => "released");
  await rejected;
  expect(run).not.toHaveBeenCalled();
  expect(await follower).toBe("released");
});

function fixture() {
  const root = tempDirs.make("openclaw-reservation-diagnostic-");
  const options = { agentId: "synthetic-private-agent", path: path.join(root, "private.sqlite") };
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
  return { options, clock, warnings };
}

it.each(["ok", "error"] as const)(
  "reports both the slow direct holder and its long-waiting fast follower (%s)",
  async (outcome) => {
    const { options, clock, warnings } = fixture();
    const entered = createDeferred();
    const release = createDeferred();
    const releaseFollower = createDeferred();
    const failure = new Error("synthetic-private-error");
    const value = { result: "synthetic-private-result" };
    const order: string[] = [];
    const observations: unknown[] = [];
    const diagnostics = channel("openclaw.agent-database.reservation");
    const observe = (observation: unknown) => {
      observations.push(observation);
    };
    diagnostics.subscribe(observe);
    const first = withSqliteReaderOwner(
      { operation: "synthetic-private-operation", ownerKind: "main" },
      () =>
        runOpenClawAgentWriteAdmission(
          options,
          async () => {
            order.push("holder");
            entered.resolve();
            await release.promise;
            if (outcome === "error") {
              throw failure;
            }
            return value;
          },
          false,
          undefined,
          undefined,
          "session-manager.write",
        ),
    );
    const settled = first.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    clock.now = 100;
    const next = runOpenClawAgentWriteAdmission(options, async () => {
      order.push("follower");
      // The holder's diagnostic continuation may run after the follower starts.
      await releaseFollower.promise;
      clock.now += 25;
      return value;
    });
    try {
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
        [
          {
            operation: "direct",
            caller: "session-manager.write",
            outcome,
            pid: process.pid,
            threadId,
            isMainThread,
            reentrant: false,
            elapsedMs: 1_600,
            queueWaitMs: 0,
            writerExecutionMs: 1_600,
            completionDelayMs: 0,
          },
          "slow agent database reservation",
        ],
        [
          expect.objectContaining({
            operation: "direct",
            outcome: "ok",
            queueWaitMs: 1_500,
            writerExecutionMs: 25,
            blockingOperation: "direct",
            blockingCaller: "session-manager.write",
          }),
          "slow agent database reservation",
        ],
      ]);
      expect(JSON.stringify(warnings)).not.toContain("synthetic-private");
      expect(JSON.stringify(warnings)).not.toContain(options.path);
      expect(observations).toEqual([
        warnings[0]![0],
        expect.objectContaining({ operation: "direct", writerExecutionMs: 25 }),
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
  const { options, clock, warnings } = fixture();
  const order: string[] = [];
  let follower: Promise<void> | undefined;
  await runOpenClawAgentWriteAdmission(options, async () => {
    await runOpenClawAgentWorkerWrite(options, async () => {
      follower = runOpenClawAgentWriteAdmission(
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
  expect(warnings.at(-1)).toEqual([
    expect.objectContaining({
      queueWaitMs: 1_000,
      writerExecutionMs: 0,
      blockingOperation: "worker",
      blockingWorkerOperations: ["session.entry.patch.commit"],
    }),
    "slow agent database reservation",
  ]);
});

it("keeps an aborted worker reservation until settlement and reports it once", async () => {
  const { options, clock, warnings } = fixture();
  const release = createDeferred();
  const entered = createDeferred();
  const controller = new AbortController();
  const reason = new Error("synthetic-private-abort");
  const order: string[] = [];
  const first = runOpenClawAgentWorkerWrite(
    options,
    async () => {
      order.push("holder");
      entered.resolve();
      await release.promise;
      const request = trackWorkerRequest("sqlite_writer", "session.entry.patch.commit");
      request.started();
      request.completed();
      controller.signal.throwIfAborted();
    },
    undefined,
    controller.signal,
  );
  const failed = expect(first).rejects.toBe(reason);
  await entered.promise;
  const next = runOpenClawAgentWorkerWrite(options, async () => {
    order.push("follower");
  });
  try {
    controller.abort(reason);
    expect(order).toEqual(["holder"]);
    clock.now = 1_000;
    release.resolve();
    await failed;
    await next;
    expect(order).toEqual(["holder", "follower"]);
    expect(warnings).toEqual([
      [
        expect.objectContaining({
          operation: "worker",
          outcome: "error",
          writerExecutionMs: 1_000,
          reentrant: false,
        }),
        "slow agent database reservation",
      ],
      [
        expect.objectContaining({
          operation: "worker",
          outcome: "ok",
          queueWaitMs: 1_000,
          writerExecutionMs: 0,
          blockingOperation: "worker",
          blockingWorkerOperations: ["session.entry.patch.commit"],
        }),
        "slow agent database reservation",
      ],
    ]);
    expect(JSON.stringify(warnings)).not.toContain("synthetic-private");
  } finally {
    release.resolve();
    await Promise.allSettled([first, next]);
  }
});

it("reports each ordered-read reservation across an awaited read without reporting reentrant borrowing", async () => {
  const { options, clock, warnings } = fixture();
  const second = { ...options, path: path.join(path.dirname(options.path), "second.sqlite") };
  const entered = createDeferred();
  const release = createDeferred();
  const read = runOpenClawAgentWriteAdmissions([second, options], async () => {
    entered.resolve();
    await release.promise;
    await runOpenClawAgentWriteAdmission(
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
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning).toEqual([
        expect.objectContaining({
          operation: "ordered-read",
          outcome: "ok",
          writerExecutionMs: 1_200,
          reentrant: false,
        }),
        "slow agent database reservation",
      ]);
    }
  } finally {
    release.resolve();
    await read;
  }
});

it("does not report a cancelled waiter as a holder", async () =>
  withSqliteDatabaseAdmissionExchange(
    () => [],
    async () => {
      const { options, clock, warnings } = fixture();
      const release = createDeferred();
      const entered = createDeferred();
      const first = runOpenClawAgentWriteAdmission(options, () => {
        entered.resolve();
        return release.promise;
      });
      await entered.promise;
      const controller = new AbortController();
      const callback = vi.fn(async () => {});
      const waiting = runOpenClawAgentWriteAdmission(
        options,
        callback,
        false,
        undefined,
        controller.signal,
      );
      const reason = new Error("cancel waiting reservation");
      const nativeCallback = vi.fn(async () => {});
      let successor: Promise<void> | undefined;
      try {
        clock.now = 1_500;
        controller.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        expect(callback).not.toHaveBeenCalled();
        expect(warnings).toEqual([]);
        successor = runWithSqliteDatabaseAdmissionTurn([options.path], nativeCallback);
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
    const pending = runOpenClawAgentWriteAdmission(options, () => {
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
    await runWithDiagnosticTraceContext(trace, () =>
      runOpenClawAgentWriteAdmission(options, () => {
        clock.now = 1_250;
      }),
    );
    await waitForDiagnosticEventsDrained();
    expect(received).toEqual([
      expect.objectContaining({
        message: "slow agent database reservation",
        level: "WARN",
        trace,
        attributes: {
          subsystem: "session-sqlite",
          operation: "direct",
          outcome: "ok",
          pid: process.pid,
          threadId,
          isMainThread,
          reentrant: false,
          elapsedMs: 1_250,
          queueWaitMs: 0,
          writerExecutionMs: 1_250,
          completionDelayMs: 0,
        },
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
