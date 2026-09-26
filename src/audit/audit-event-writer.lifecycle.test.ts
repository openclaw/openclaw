import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { AuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import type { AuditWriterOperations, AuditWriterResult } from "./audit-event-writer.types.js";

const { execute } = vi.hoisted(() => ({
  execute:
    vi.fn<(command: SqliteWorkerCommand<AuditWriterOperations>) => Promise<AuditWriterResult>>(),
}));

vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: (
    _context: OpenClawStateWorkerContext,
    operation: (scope: { execute: typeof execute }) => Promise<AuditWriterResult>,
  ) => operation({ execute }),
}));

beforeEach(() => {
  execute.mockReset();
  vi.useFakeTimers({
    toFake: [
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

function event(sourceId: string): AuditEventInput {
  return {
    sourceId,
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: sourceId,
  };
}

async function advanceDispatch() {
  await vi.advanceTimersByTimeAsync(1);
  await vi.dynamicImportSettled();
}

describe("audit writer async settlement", () => {
  it("coalesces overdue idle maintenance and cancels it after writer shutdown", async () => {
    vi.useRealTimers();
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    execute.mockResolvedValue({ status: "settled" });
    const writer = createAuditEventWriter({
      scheduler,
      stateDir: tempDirs.make("audit-writer-maintenance-"),
    });
    try {
      await writer.ready;
      execute.mockClear();
      const pruned = createDeferred();
      execute.mockImplementation(async (command) => {
        if (command.type === "audit.writer.prune" && command.input === "progress") {
          pruned.resolve();
        }
        return { status: "settled" };
      });
      await clock.advanceBy(60 * 60_000 - 1);
      expect(execute).not.toHaveBeenCalled();
      await clock.advanceBy(2 * 60 * 60_000 + 1);
      await pruned.promise;
      expect(
        execute.mock.calls.filter(
          ([command]) => command.type === "audit.writer.prune" && command.input === "events",
        ),
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

  it("retains in-flight capacity and joins submission after the shutdown deadline", async () => {
    const submitted = createDeferred();
    const finish = createDeferred<AuditWriterResult>();
    const requests: string[] = [];
    execute.mockImplementation(async (command) => {
      if (command.type === "audit.writer.prune") {
        return { status: "settled" };
      }
      if (command.input.type !== "record-event") {
        throw new Error("Unexpected audit request in event lifecycle test");
      }
      requests.push(command.input.input.sourceId);
      submitted.resolve();
      return await finish.promise;
    });
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      scheduler: createTestGatewayScheduler(),
      stateDir: tempDirs.make("audit-writer-settlement-"),
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
      const stopping = writer.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
    }
  });

  it("does not replay an unknown transport outcome with SQLite busy fields", async () => {
    const submitted = createDeferred();
    const firstResult = createDeferred<AuditWriterResult>();
    const requests: string[] = [];
    execute.mockImplementation(async (command) => {
      if (command.type === "audit.writer.prune") {
        return { status: "settled" };
      }
      if (command.input.type !== "record-event") {
        throw new Error("Unexpected audit request in event lifecycle test");
      }
      const sourceId = command.input.input.sourceId;
      requests.push(sourceId);
      if (sourceId === "unknown-outcome") {
        submitted.resolve();
        return await firstResult.promise;
      }
      return { status: "settled" };
    });
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      scheduler: createTestGatewayScheduler(),
      stateDir: tempDirs.make("audit-writer-unknown-outcome-"),
      onError: (error) => errors.push(error),
    });
    try {
      await advanceDispatch();
      await writer.ready;
      expect(writer.record(event("unknown-outcome"))).toBe(true);
      expect(writer.record(event("next"))).toBe(true);
      await advanceDispatch();
      await submitted.promise;
      expect(requests).toEqual(["unknown-outcome"]);
      const stopping = writer.stop();
      const failure = Object.assign(
        new SqliteWorkerError(
          "Audit write outcome is unknown: database is locked",
          "outcome-unknown",
        ),
        { errcode: 5, errstr: "SQLITE_BUSY" },
      );
      firstResult.reject(failure);
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      expect(errors).toEqual([failure.message]);
      expect(requests).toEqual(["unknown-outcome", "next"]);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(errors).toEqual([failure.message]);
      expect(requests).toEqual(["unknown-outcome", "next"]);
    } finally {
      firstResult.resolve({ status: "settled" });
      const stopping = writer.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
    }
  });
  it("releases settled capacity before notifying the error observer", async () => {
    const requests: string[] = [];
    execute.mockImplementation(async (command) => {
      if (command.type === "audit.writer.prune") {
        return { status: "settled" };
      }
      if (command.input.type !== "record-event") {
        throw new Error("Unexpected audit request");
      }
      const sourceId = command.input.input.sourceId;
      requests.push(sourceId);
      if (sourceId === "unknown-outcome") {
        throw new SqliteWorkerError("Audit write outcome is unknown", "outcome-unknown");
      }
      return { status: "settled" };
    });
    const errors: string[] = [];
    let offered = false;
    let followUpAccepted: boolean | undefined;
    const writer = createAuditEventWriter({
      scheduler: createTestGatewayScheduler(),
      stateDir: tempDirs.make("audit-writer-error-notification-"),
      maxPending: 1,
      onError: (error) => {
        errors.push(error);
        if (!offered) {
          offered = true;
          followUpAccepted = writer.record(event("from-error-observer"));
        }
      },
    });
    try {
      await advanceDispatch();
      await writer.ready;
      expect(writer.record(event("unknown-outcome"))).toBe(true);
      await advanceDispatch();
      const stopping = writer.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      expect(followUpAccepted).toBe(true);
      expect(errors).toEqual(["Audit write outcome is unknown"]);
      expect(requests).toEqual(["unknown-outcome", "from-error-observer"]);
    } finally {
      const stopping = writer.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
    }
  });
});
