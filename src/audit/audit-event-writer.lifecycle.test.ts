import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withSqliteWorkerCleanupFailure } from "../infra/sqlite-worker-broker-reply.js";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { AgentRunStartedAuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import { input } from "./audit-event-writer.test-support.js";
import type { AuditWriterResult } from "./audit-event-writer.types.js";
import type { AuditWriterOperations } from "./audit-event-writer.worker.js";

const { execute } = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        command: SqliteWorkerCommand<AuditWriterOperations>,
      ) => Promise<AuditWriterResult[] | undefined>
    >(),
}));

// mock-isolation: Exercise FIFO scheduling without opening the shared-state worker.
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: (
    _context: OpenClawStateWorkerContext,
    operation: (scope: { execute: typeof execute }) => Promise<AuditWriterResult[] | undefined>,
  ) => operation({ execute }),
}));

beforeEach(() => {
  execute.mockReset();
  vi.useFakeTimers({
    toFake: [
      "performance",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function startWriter(options: Partial<Parameters<typeof createAuditEventWriter>[0]> = {}) {
  return createAuditEventWriter({
    ...options,
    scheduler: options.scheduler ?? createTestGatewayScheduler(),
    stateDir: tempDirs.make("audit-writer-"),
  });
}

function event(sourceId: string): AgentRunStartedAuditEventInput {
  return { ...input(), sourceId, runId: sourceId };
}

function mockEventRequests(handler: (sourceId: string) => Promise<AuditWriterResult>) {
  const requests: string[] = [];
  execute.mockImplementation(async (command) => {
    if (command.type === "audit.writer.prune") {
      return [];
    }
    const results: AuditWriterResult[] = [];
    for (const request of command.input) {
      if (request.type !== "record-event" && request.type !== "record-run") {
        throw new Error("Unexpected audit request in event lifecycle test");
      }
      const sourceId =
        request.type === "record-run" ? request.start.sourceId : request.input.sourceId;
      requests.push(sourceId);
      const result = await handler(sourceId);
      results.push(result);
      if (result.status === "retry") {
        break;
      }
    }
    return results;
  });
  return requests;
}

async function stopWriter(writer: ReturnType<typeof startWriter>) {
  const stopping = writer.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  await stopping;
}

async function advanceDispatch() {
  await vi.advanceTimersByTimeAsync(5);
  await vi.dynamicImportSettled();
}

describe("audit writer async settlement", () => {
  it.each([false, true])("coalesces neighboring turns (early shutdown: %s)", async (stopEarly) => {
    const requests = mockEventRequests(async () => ({ status: "settled" }));
    const writer = startWriter();
    try {
      await vi.advanceTimersByTimeAsync(5);
      await writer.ready;
      execute.mockClear();
      for (const sourceId of ["first", "second", "third"]) {
        expect(writer.record(event(sourceId))).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(requests).toEqual(["first"]);
      if (stopEarly) {
        void writer.stop();
      }
      await vi.advanceTimersByTimeAsync(stopEarly ? 0 : 3);
      expect(requests).toEqual(["first", "second", "third"]);
      expect(execute).toHaveBeenCalledTimes(stopEarly ? 3 : 2);
    } finally {
      await stopWriter(writer);
    }
  });

  it("counts both run records against the pending budget and releases them after settlement", async () => {
    const requests = mockEventRequests(async () => ({ status: "settled" }));
    const errors: string[] = [];
    const writer = startWriter({
      maxPending: 2,
      onError: (error) => errors.push(error),
    });
    try {
      await advanceDispatch();
      await writer.ready;
      const start = event("pair");
      expect(
        writer.recordRun(start, {
          ...start,
          sourceId: "pair:end",
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        }),
      ).toBe(true);
      expect(writer.record(event("full"))).toBe(false);
      await advanceDispatch();
      expect(writer.record(event("after"))).toBe(true);
      await advanceDispatch();
      expect(requests).toEqual(["pair", "after"]);
      expect(errors).toEqual(["audit event queue is full (2); dropping metadata"]);
    } finally {
      await stopWriter(writer);
    }
  });

  it("coalesces overdue idle maintenance and cancels it after writer shutdown", async () => {
    vi.useRealTimers();
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    execute.mockResolvedValue([]);
    const writer = startWriter({ scheduler });
    try {
      await writer.ready;
      execute.mockClear();
      const pruned = createDeferred();
      execute.mockImplementation(async (command) => {
        if (command.type === "audit.writer.prune") {
          pruned.resolve();
          return [];
        }
        return [{ status: "settled" }];
      });
      await clock.advanceBy(60 * 60_000 - 1);
      expect(execute).not.toHaveBeenCalled();
      await clock.advanceBy(2 * 60 * 60_000 + 1);
      await pruned.promise;
      expect(
        execute.mock.calls.filter(([command]) => command.type === "audit.writer.prune"),
      ).toHaveLength(1);

      await writer.stop();
      execute.mockClear();
      await clock.advanceBy(60 * 60_000);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await writer.stop();
      await scheduler.stop();
    }
  });

  it("reports maintenance errors before backing off contention and draining queued writes", async () => {
    const requests = mockEventRequests(async () => ({ status: "settled" }));
    execute.mockResolvedValueOnce([
      { status: "settled", deleted: 1 },
      { status: "settled", error: "synthetic identity prune failure" },
      { status: "retry" },
    ]);
    const errors: string[] = [];
    const writer = startWriter({ onError: (error) => errors.push(error) });
    try {
      await advanceDispatch();
      await writer.ready;
      expect(errors).toEqual(["synthetic identity prune failure"]);
      expect(writer.record(event("after-maintenance"))).toBe(true);
      await vi.advanceTimersByTimeAsync(19);
      expect(requests).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6);
      expect(requests).toEqual(["after-maintenance"]);
      expect(errors).toEqual(["synthetic identity prune failure"]);
    } finally {
      await stopWriter(writer);
    }
  });

  it("joins a submitted maintenance pass after shutdown drops waiting metadata", async () => {
    const finish = createDeferred<AuditWriterResult[]>();
    execute.mockReturnValue(finish.promise);
    const errors: string[] = [];
    const writer = startWriter({ onError: (error) => errors.push(error) });
    try {
      expect(writer.record(event("waiting"))).toBe(true);
      await advanceDispatch();
      expect(execute).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = writer.stop();
      void stopping.then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stopped).toBe(false);
      expect(errors).toEqual([
        "audit event writer shutdown timed out; pending metadata may be lost",
      ]);
      finish.resolve([{ status: "settled", deleted: 1 }]);
      await stopping;
      await writer.ready;
      expect(stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(errors).toHaveLength(1);
    } finally {
      finish.resolve([]);
      await stopWriter(writer);
    }
  });

  it("retains in-flight capacity and joins submission after the shutdown deadline", async () => {
    const submitted = createDeferred();
    const finish = createDeferred<AuditWriterResult>();
    const requests = mockEventRequests(async () => {
      submitted.resolve();
      return await finish.promise;
    });
    const errors: string[] = [];
    const writer = startWriter({
      maxPending: 2,
      onError: (error) => errors.push(error),
    });
    try {
      await advanceDispatch();
      await writer.ready;
      expect(writer.record(event("submitted"))).toBe(true);
      await advanceDispatch();
      await submitted.promise;
      expect(writer.record(event("waiting"))).toBe(true);
      expect(writer.record(event("overflow"))).toBe(false);
      await advanceDispatch();
      expect(requests).toEqual(["submitted"]);
      const callsBeforeStop = execute.mock.calls.length;

      let stopped = false;
      const stopping = writer.stop();
      void stopping.then(() => {
        stopped = true;
      });
      expect(writer.stop()).toBe(stopping);
      expect(writer.record(event("after-stop"))).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stopped).toBe(false);
      expect(execute).toHaveBeenCalledTimes(callsBeforeStop);
      expect(errors).toEqual([
        "audit event queue is full (2); dropping metadata",
        "audit event writer shutdown timed out; pending metadata may be lost",
      ]);

      finish.resolve({ status: "settled" });
      await stopping;
      expect(stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(requests).toEqual(["submitted"]);
      expect(execute).toHaveBeenCalledTimes(callsBeforeStop);
      expect(errors).toHaveLength(2);
    } finally {
      finish.resolve({ status: "settled" });
      await stopWriter(writer);
    }
  });

  it("retries only the uncommitted suffix before newer queued events", async () => {
    let contended = false;
    const requests = mockEventRequests(async (sourceId) => {
      if (sourceId === "blocked" && !contended) {
        contended = true;
        return { status: "retry" };
      }
      return { status: "settled" };
    });
    const writer = startWriter();
    try {
      await advanceDispatch();
      await writer.ready;
      for (const sourceId of ["committed", "blocked", "tail"]) {
        expect(writer.record(event(sourceId))).toBe(true);
      }
      await advanceDispatch();
      expect(requests).toEqual(["committed", "blocked"]);
      expect(writer.record(event("newer"))).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      expect(requests).toEqual(["committed", "blocked", "blocked", "tail", "newer"]);
    } finally {
      await stopWriter(writer);
    }
  });

  it("replays a cleanup-wrapped unknown outcome before newer queued events", async () => {
    let failed = false;
    const unknown = new SqliteWorkerError("Audit write outcome is unknown", "outcome-unknown");
    const failure = withSqliteWorkerCleanupFailure(unknown, new Error("Synthetic cleanup failure"));
    const requests = mockEventRequests(async (sourceId) => {
      if (sourceId === "unknown-outcome" && !failed) {
        failed = true;
        throw failure;
      }
      return { status: "settled" };
    });
    const errors: string[] = [];
    const writer = startWriter({ onError: (error) => errors.push(error) });
    try {
      await advanceDispatch();
      await writer.ready;
      const start = event("unknown-outcome");
      expect(
        writer.recordRun(start, {
          ...start,
          sourceId: "unknown-outcome:end",
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        }),
      ).toBe(true);
      expect(writer.record(event("tail"))).toBe(true);
      await advanceDispatch();
      expect(requests).toEqual(["unknown-outcome"]);
      expect(writer.record(event("newer"))).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      await advanceDispatch();
      expect(requests).toEqual(["unknown-outcome", "unknown-outcome", "tail", "newer"]);
      const batches = execute.mock.calls.flatMap(([command]) =>
        command.type === "audit.writer.process" ? [command.input] : [],
      );
      expect(batches[0]?.[0]).toMatchObject({ eventIds: [expect.any(String), expect.any(String)] });
      expect(batches[1]).toEqual(batches[0]);
      expect(errors).toEqual([failure.message]);
    } finally {
      await stopWriter(writer);
    }
  });

  it("settles an absent-database batch once without rescheduling", async () => {
    execute.mockResolvedValue(undefined);
    const writer = startWriter();
    try {
      await advanceDispatch();
      await writer.ready;
      execute.mockClear();
      expect(writer.record(event("first"))).toBe(true);
      expect(writer.record(event("second"))).toBe(true);
      await advanceDispatch();
      const attempts = execute.mock.calls.length;
      // The absent existing-only attempt falls back to the normal worker open once.
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(attempts);
    } finally {
      await stopWriter(writer);
    }
  });
});
