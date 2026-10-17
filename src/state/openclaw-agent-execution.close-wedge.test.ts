import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as backoff from "../infra/backoff.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import type { SqliteWorkerExecutionAuthority } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  readSqliteWorkerExecutionAuthority,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveSqliteBrokerWorkerCount } from "../infra/worker-pool-sizing.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { readAgentDatabaseExecutionAuthority } from "./openclaw-agent-execution-authority.js";
import type { AgentDatabaseExecutionScope } from "./openclaw-agent-execution-contract.js";
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
    // Fault 2: transient lease insertion/cleanup failures.
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      const faults = [
        [/insert into "?agent_database_leases"?/i, (fault) => {
          if (Atomics.compareExchange(fault, 0, 3, 0) === 3 || Atomics.load(fault, 0) === 4) {
            Atomics.add(fault, 2, 1);
            throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
          }
        }],
        [/delete from "?agent_database_leases"?/i, (fault) => {
          Atomics.add(fault, 1, 1);
          if (Atomics.load(fault, 0) === 1) {
            throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10, errstr: "disk I/O error" });
          }
        }],
      ];
      for (const [pattern, fail] of faults) {
        if (!pattern.test(sql)) continue;
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          fail(new Int32Array(workerData.closeWedgeEnabled));
          return run(...args);
        };
      }
      return statement;
    };
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
const makeEnv = () => ({
  OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-wedge-")),
});
const capture = (env: ReturnType<typeof makeEnv>, agentId = "first") =>
  captureOpenClawAgentDatabaseExecution({ agentId, env });
const faultState = new Int32Array(fault.enabled);

it.each(["retry", "deadline", "shutdown"] as const)(
  "keeps contention recoverable while preserving the %s boundary",
  async (ending) => {
    const execution = capture(makeEnv());
    const terminal = vi.fn();
    execution.onTerminal(terminal);
    const attempts = Atomics.load(faultState, 2);
    Atomics.store(faultState, 0, ending === "deadline" ? 4 : 3);
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
      expect(Atomics.load(faultState, 2)).toBeGreaterThan(attempts);
      Atomics.store(faultState, 0, 0);
      if (ending !== "shutdown") {
        expect(terminal).not.toHaveBeenCalled();
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
      Atomics.store(faultState, 0, 0);
      await execution.release();
    }
  },
);

function executionSource(
  observe?: (authority: SqliteWorkerExecutionAuthority) => void,
  beforeAuthorize?: (request: SqliteWorkerAdmissionRequest) => void,
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent: () => undefined,
    createAdmission: (binding) => () => {
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        beforeAuthorize?.(request);
        binding.authorize(request);
        const authority = readSqliteWorkerExecutionAuthority(admission);
        if (authority) {
          observe?.(authority);
        }
        if (!grant()) {
          throw new Error("Close wedge fixture lost admission");
        }
      }, binding.attachment);
      return { nativeLocations: binding.nativeLocations, admission };
    },
  };
}
const source = executionSource();
function readEntries(
  execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution>,
  key: string | string[],
  request = source,
) {
  return execution.runExisting(request, (scope) =>
    scope.execute({
      type: "session.entry.read",
      input: { sessionKeys: typeof key === "string" ? [key] : key },
    }),
  );
}

it("recovers retained borrowers after native loss without replaying the failed operation", async () => {
  const env = makeEnv();
  const first = capture(env);
  const sibling = capture(env);
  try {
    await first.prepare(source);
    const claim = sibling.captureGenerationClaim();
    const failed = vi.fn((scope: AgentDatabaseExecutionScope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: [fault.marker] } }),
    );
    Atomics.store(faultState, 0, 2);
    await expect(first.runExisting(source, failed)).rejects.toBeInstanceOf(Error);
    Atomics.store(faultState, 0, 0);
    expect(failed).toHaveBeenCalledOnce();
    expect(() => claim.assertCurrent()).toThrow();

    // Another live chat retains this borrower while the failed command settles.
    expect(await readEntries(sibling, "recovered")).toMatchObject({ entries: [] });
    const replacement = sibling.capturePreparedGenerationClaim();
    expect(replacement?.identity).toBe(claim.identity);
    expect(replacement?.incarnation).not.toBe(claim.incarnation);
    expect(() => claim.assertCurrent()).toThrow();
    expect(await readEntries(first, "still-healthy")).toMatchObject({ entries: [] });
    expect(failed).toHaveBeenCalledOnce();
  } finally {
    Atomics.store(faultState, 0, 0);
    await Promise.allSettled([first.release(), sibling.release()]);
  }
});

it("reopens a native generation lost between operations before dispatch", async () => {
  const execution = capture(makeEnv());
  await execution.prepare(source);
  expect(await readEntries(execution, "healthy")).toMatchObject({ entries: [] });
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
  expect(await readEntries(execution, "still-healthy")).toMatchObject({ entries: [] });
  await execution.release();
});

it("surfaces the native cleanup cause while the close still fails, then recovers once it clears", async () => {
  const env = makeEnv();
  const first = capture(env);
  let authority: SqliteWorkerExecutionAuthority | undefined;
  const observed = executionSource((captured) => (authority = captured));
  await first.prepare(observed);
  await readEntries(first, "healthy", observed);
  expect(authority).toBeDefined();
  const original = authority!;
  expect(readAgentDatabaseExecutionAuthority(original)).toBe(true);

  Atomics.store(faultState, 0, 1);
  const failure: unknown = await readEntries(first, fault.marker).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(formatErrorMessageWithCode(failure)).toContain("Agent operation and cleanup failed");
  expect(readAgentDatabaseExecutionAuthority(original)).toBe(false);
  await first.release().catch(() => undefined);

  const second = capture(env, "second");
  await second.prepare(source);
  expect(await second.runExisting(source, async () => "second usable")).toBe("second usable");
  await second.release();

  const liveWorkers = fault.workers.size;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retries = [capture(env), capture(env)];
    for (const retry of retries) {
      expect(retry.capturePreparedGenerationClaim()).toBeUndefined();
    }
    const releases = Atomics.load(faultState, 1);
    const results = await Promise.allSettled(retries.map((retry) => retry.prepare(source)));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(formatErrorMessageWithCode(result.reason)).toContain("disk I/O error");
        expect(formatErrorMessageWithCode(result.reason)).not.toContain("admission is closed");
      }
    }
    expect(Atomics.load(faultState, 1) - releases).toBe(1);
    await Promise.all(retries.map((retry) => retry.release()));
    expect(fault.workers.size).toBe(liveWorkers);
    expect(readAgentDatabaseExecutionAuthority(original)).toBe(false);
  }

  Atomics.store(faultState, 0, 0);
  const recovered = capture(env);
  expect(await readEntries(recovered, "recovered", observed)).toMatchObject({ entries: [] });
  expect(recovered.capturePreparedGenerationClaim()).toBeDefined();
  expect(authority!.logical.buffer).toBe(original.logical.buffer);
  expect(authority!.native.buffer).not.toBe(original.native.buffer);
  expect(readAgentDatabaseExecutionAuthority(authority!)).toBe(true);
  expect(readAgentDatabaseExecutionAuthority(original)).toBe(false);
  await recovered.release();
});

it("keeps another agent's admitted database usable after a deleted agent refuses preparation", async () => {
  const env = makeEnv();
  const retained = capture(env, "main");
  const initial = capture(env, "removed");
  const peers = Array.from({ length: resolveSqliteBrokerWorkerCount() - 1 }, (_, index) =>
    capture(env, `peer-${index}`),
  );
  const admitted = [retained, ...peers];
  for (const peer of admitted) {
    await peer.prepare(source);
  }
  await initial.prepare(source);
  await initial.release();
  await closeOpenClawAgentDatabaseByPathAsync(initial.path, "removed");
  beginAgentDeletionJournal(
    {
      agentId: "removed",
      operationId: "deletion-refusal-fixture",
      deleteFiles: true,
      agentDir: path.dirname(initial.path),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "removed-workspace"),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "removed-sessions"),
    },
    { env },
  );
  const refused = capture(env, "removed");
  let survivors: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const refusingSource = executionSource(undefined, (request) => {
    if (
      !survivors &&
      request.stage === "prepare" &&
      request.facts &&
      typeof request.facts === "object" &&
      "kind" in request.facts &&
      request.facts.kind === "shared-owner"
    ) {
      survivors = Promise.allSettled(admitted.map((survivor) => readEntries(survivor, [])));
    }
  });
  try {
    await expect(refused.prepare(refusingSource)).rejects.toThrow("agent removed is deleted");
    expect(survivors).toBeDefined();
    const results = await survivors;
    for (const survivor of admitted) {
      survivor.assertCurrent();
    }
    expect(results).toEqual(
      admitted.map(() => ({
        status: "fulfilled",
        value: expect.objectContaining({ kind: "session-exact-entries", entries: [] }),
      })),
    );
    const repeated = capture(env, "removed");
    try {
      await expect(repeated.prepare(source)).rejects.toThrow("agent removed is deleted");
    } finally {
      await repeated.release();
    }
  } finally {
    await Promise.allSettled([
      retained.release(),
      refused.release(),
      ...peers.map((peer) => peer.release()),
    ]);
  }
});
