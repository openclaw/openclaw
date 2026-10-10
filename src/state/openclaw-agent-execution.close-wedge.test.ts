import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as backoff from "../infra/backoff.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

// Kill the real worker mid-operation, then refuse its lease release. Recovery must
// retain cleanup custody without permanently refusing later requests (#159438).
const fault = vi.hoisted(() => ({
  marker: "close-wedge-kill-marker",
  enabled: new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
  workers: new Set<Worker>(),
}));

vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { MessagePort, workerData } from "node:worker_threads";
    // Fault 2: while enabled, the retired lease cannot be released (mimics the
    // transient SQLITE_IOERR that made the native close fail in production).
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (/insert into "?agent_database_leases"?/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          const fault = new Int32Array(workerData.closeWedgeEnabled);
          if (Atomics.compareExchange(fault, 0, 3, 0) === 3 || Atomics.load(fault, 0) === 4) {
            Atomics.add(fault, 2, 1);
            throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
          }
          return run(...args);
        };
      }
      if (/delete from "?agent_database_leases"?/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          Atomics.add(new Int32Array(workerData.closeWedgeEnabled), 1, 1);
          if (Atomics.load(new Int32Array(workerData.closeWedgeEnabled), 0) === 1) {
            throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10, errstr: "disk I/O error" });
          }
          return run(...args);
        };
      }
      return statement;
    };
    // Fault 1: the agent worker exits while handling the marked command.
    const on = MessagePort.prototype.on;
    MessagePort.prototype.on = function (event, listener) {
      if (event !== "message") {
        return on.call(this, event, listener);
      }
      return on.call(this, event, function (message) {
        if (Atomics.load(new Int32Array(workerData.closeWedgeEnabled), 0)) {
          let text = "";
          try {
            const input = message && message.input;
            text = input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1") : "";
          } catch {}
          if (text.includes(workerData.closeWedgeMarker)) {
            // The native store disappears mid-operation (worker exit → broker fail(slot)).
            process.exit(3);
          }
        }
        return listener.call(this, message);
      });
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      const worker = actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          closeWedgeMarker: fault.marker,
          closeWedgeEnabled: fault.enabled,
        },
      });
      fault.workers.add(worker);
      worker.once("exit", () => fault.workers.delete(worker));
      return worker;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    Atomics.store(new Int32Array(fault.enabled), 0, 0);
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each(["retry", "deadline", "shutdown"] as const)(
  "keeps contention recoverable while preserving the %s boundary",
  async (ending) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-open-contention-")) };
    const execution = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
    const attempts = Atomics.load(new Int32Array(fault.enabled), 2);
    Atomics.store(new Int32Array(fault.enabled), 0, ending === "deadline" ? 4 : 3);
    const clock = vi.spyOn(performance, "now");
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      if (ending === "shutdown") {
        await closeOpenClawAgentDatabasesAsync();
      } else if (ending === "deadline") {
        clock.mockReturnValue(performance.now() + 2_000);
      }
    });
    try {
      const preparing = execution.prepare(source);
      if (ending === "retry") {
        await preparing;
      } else {
        await expect(preparing).rejects.toThrow(ending === "shutdown" ? /closed/ : /locked/);
      }
      expect(Atomics.load(new Int32Array(fault.enabled), 2)).toBeGreaterThan(attempts);
      Atomics.store(new Int32Array(fault.enabled), 0, 0);
      if (ending !== "shutdown") {
        execution.assertCurrent();
        await execution.prepare(source);
        const operation = vi.fn(async () => "recovered");
        expect(await execution.runExisting(source, operation)).toBe("recovered");
        expect(operation).toHaveBeenCalledOnce();
        const failure = Object.assign(new Error("database is locked"), { errcode: 5 });
        const rejected = vi.fn(async () => {
          throw failure;
        });
        await expect(execution.runExisting(source, rejected)).rejects.toBe(failure);
        expect(rejected).toHaveBeenCalledOnce();
        await closeOpenClawAgentDatabasesAsync();
      }
      expect(() => execution.assertCurrent()).toThrow(/closed/);
    } finally {
      Atomics.store(new Int32Array(fault.enabled), 0, 0);
      await execution.release();
    }
  },
);

const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Close wedge fixture lost admission");
        }
      }, binding.attachment),
    });
  },
};

it("recovers after a failed operation with successful native close", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-wedge-")) };
  const first = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  await first.prepare(source);
  expect(await first.runExisting(source, async () => "healthy")).toBe("healthy");

  // 1. The operation fails because the native store becomes unavailable mid-run.
  Atomics.store(new Int32Array(fault.enabled), 0, 2);
  const failure: unknown = await first
    .runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: [fault.marker] } }),
    )
    .catch((error: unknown) => error);
  Atomics.store(new Int32Array(fault.enabled), 0, 0);
  expect(failure).toBeInstanceOf(Error);
  console.log(`[close-wedge] operation failure: ${formatErrorMessageWithCode(failure)}`);
  await first.release().catch((error: unknown) => {
    console.log(`[close-wedge] release failure: ${formatErrorMessageWithCode(error)}`);
  });

  // 2. The fault is gone. A fresh capture for the same agent must be admitted again;
  //    on 2026.9.6 it throws
  //    "Agent database execution admission is closed" until the gateway restarts.
  const retry = await Promise.resolve()
    .then(async () => {
      const execution = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
      await execution.prepare(source);
      return execution;
    })
    .catch((error: unknown) => {
      console.log(`[close-wedge] re-admission failure: ${formatErrorMessageWithCode(error)}`);
      throw error;
    });
  expect(
    await retry.runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: ["recovered"] } }),
    ),
  ).toMatchObject({ entries: [] });
  await retry.release();
});

it("reopens a native generation lost between operations before dispatch", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-native-preflight-")) };
  const execution = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  await execution.prepare(source);
  expect(
    await execution.runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: ["healthy"] } }),
    ),
  ).toMatchObject({ entries: [] });
  const claim = execution.captureGenerationClaim();
  expect(() => claim.assertCurrent()).not.toThrow();

  const agentWorker = [...fault.workers].at(-1);
  expect(agentWorker).toBeDefined();
  await agentWorker!.terminate();
  expect(() => claim.assertCurrent()).toThrow("Agent database execution lost its native owner");

  let dispatched = 0;
  expect(
    await execution.runExisting(source, (scope) => {
      dispatched += 1;
      return scope.execute({ type: "session.entry.read", input: { sessionKeys: ["recovered"] } });
    }),
  ).toMatchObject({ entries: [] });
  expect(dispatched).toBe(1);
  const replacement = execution.capturePreparedGenerationClaim();
  expect(replacement?.identity).toBe(claim.identity);
  expect(replacement?.incarnation).not.toBe(claim.incarnation);
  expect(() => claim.assertCurrent()).toThrow("Agent database execution generation was replaced");
  expect(
    await execution.runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: ["still-healthy"] } }),
    ),
  ).toMatchObject({ entries: [] });
  await execution.release();
});

it("surfaces the native cleanup cause while the close still fails, then recovers once it clears", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-wedge-scope-")) };
  const first = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  await first.prepare(source);

  // The fault stays enabled through the whole retry below.
  Atomics.store(new Int32Array(fault.enabled), 0, 1);
  const failure: unknown = await first
    .runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: [fault.marker] } }),
    )
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(formatErrorMessageWithCode(failure)).toContain("Agent operation and cleanup failed");
  await first.release().catch(() => undefined);

  // Another agent on the same state directory is not affected.
  const second = captureOpenClawAgentDatabaseExecution({ agentId: "second", env });
  await second.prepare(source);
  expect(await second.runExisting(source, async () => "second usable")).toBe("second usable");
  await second.release();

  // Retained borrowers share one cleanup attempt, with no replacement native owner.
  const liveWorkers = fault.workers.size;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retries = [
      captureOpenClawAgentDatabaseExecution({ agentId: "first", env }),
      captureOpenClawAgentDatabaseExecution({ agentId: "first", env }),
    ];
    for (const retry of retries) {
      expect(retry.capturePreparedGenerationClaim()).toBeUndefined();
    }
    const releases = Atomics.load(new Int32Array(fault.enabled), 1);
    const results = await Promise.allSettled(retries.map((retry) => retry.prepare(source)));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(formatErrorMessageWithCode(result.reason)).toContain("disk I/O error");
        expect(formatErrorMessageWithCode(result.reason)).not.toContain("admission is closed");
      }
    }
    expect(Atomics.load(new Int32Array(fault.enabled), 1) - releases).toBe(1);
    await Promise.all(retries.map((retry) => retry.release()));
    expect(fault.workers.size).toBe(liveWorkers);
  }

  // Once the cause is gone the same agent recovers without a process restart.
  Atomics.store(new Int32Array(fault.enabled), 0, 0);
  const recovered = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  expect(
    await recovered.runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: ["recovered"] } }),
    ),
  ).toMatchObject({ entries: [] });
  expect(recovered.capturePreparedGenerationClaim()).toBeDefined();
  await recovered.release();
});
