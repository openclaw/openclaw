import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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
import { withSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import * as logging from "../logging/logger.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
  runOpenClawAgentWriteAdmissions,
} from "./openclaw-agent-write-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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
  "reports the slow direct holder, not its long-waiting fast follower (%s)",
  async (outcome) => {
    const { options, clock, warnings } = fixture();
    const release = createDeferred();
    const failure = new Error("synthetic-private-error");
    const value = { result: "synthetic-private-result" };
    const order: string[] = [];
    const first = withSqliteReaderOwner(
      { operation: "synthetic-private-operation", ownerKind: "main" },
      () =>
        runOpenClawAgentWriteAdmission(options, async () => {
          order.push("holder");
          await release.promise;
          if (outcome === "error") {
            throw failure;
          }
          return value;
        }),
    );
    const settled = first.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    clock.now = 100;
    const next = runOpenClawAgentWriteAdmission(options, () => {
      order.push("follower");
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
      expect(await next).toBe(value);
      expect(order).toEqual(["holder", "follower"]);
      expect(warnings).toEqual([
        [
          {
            operation: "direct",
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
      ]);
      expect(JSON.stringify(warnings)).not.toContain("synthetic-private");
      expect(JSON.stringify(warnings)).not.toContain(options.path);
    } finally {
      release.resolve();
      await Promise.allSettled([first, next]);
    }
  },
);

it("keeps an aborted worker reservation until settlement and reports it once", async () => {
  const { options, clock, warnings } = fixture();
  const release = createDeferred();
  const controller = new AbortController();
  const reason = new Error("synthetic-private-abort");
  const order: string[] = [];
  const first = runOpenClawAgentWorkerWrite(
    options,
    async () => {
      order.push("holder");
      await release.promise;
      controller.signal.throwIfAborted();
    },
    undefined,
    controller.signal,
  );
  const failed = expect(first).rejects.toBe(reason);
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

it("does not report a cancelled waiter as a holder", async () => {
  const { options, clock, warnings } = fixture();
  const release = createDeferred();
  const first = runOpenClawAgentWriteAdmission(options, () => release.promise);
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
  try {
    clock.now = 1_500;
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(callback).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([first, waiting]);
  }
});

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
