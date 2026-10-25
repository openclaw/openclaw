import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionActorFactory } from "../config/sessions/session-actor-durable.js";
import * as backoff from "../infra/backoff.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
  SqliteWorkerError,
  type SqliteWorkerExecutionAuthority,
} from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  readSqliteWorkerExecutionAuthority,
} from "../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
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
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  createOpenClawStateWorkerLease,
  executeOpenClawStateWorker,
} from "./openclaw-state-worker-store.js";

// Kill the real worker mid-operation, then refuse its lease release. Recovery must
// retain cleanup custody without permanently refusing later requests (#159438).
const fault = vi.hoisted(() => ({
  marker: "close-wedge-kill-marker",
  enabled: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
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
      if ([5, 6].includes(Atomics.load(new Int32Array(workerData.closeWedgeEnabled), 0)) &&
          (Atomics.load(new Int32Array(workerData.closeWedgeEnabled), 0) === 6 ||
          this.location()?.endsWith("openclaw-agent.sqlite")) && /insert into/i.test(sql)) {
        const pages = prepare.call(this, "PRAGMA page_count").get().page_count;
        this.exec("PRAGMA max_page_count=" + pages);
      }
      const statement = prepare.call(this, sql);
      if (/insert into|delete from "?agent_database_leases"?/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          const fault = new Int32Array(workerData.closeWedgeEnabled);
          if (/insert into "?agent_database_leases"?/i.test(sql) &&
              (Atomics.compareExchange(fault, 0, 3, 0) === 3 || Atomics.load(fault, 0) === 4)) {
            Atomics.add(fault, 2, 1);
            throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
          }
          if (/delete from "?agent_database_leases"?/i.test(sql)) {
            Atomics.add(fault, 1, 1);
            if (Atomics.load(fault, 0) === 1) {
              throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10, errstr: "disk I/O error" });
            }
          }
          try {
            return run(...args);
          } catch (error) {
            if (/insert into/i.test(sql) && [5, 6].includes(Atomics.load(fault, 0)) && error.errcode === 13) {
              // Lose the reply after a real SQLITE_FULL, leaving its outcome unknown to the host.
              Atomics.add(fault, 3, 1);
              process.exit(3);
            }
            throw error;
          }
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

function releaseOnExit(...resources: { release(): Promise<void> }[]) {
  return {
    async [Symbol.asyncDispose]() {
      Atomics.store(faultState, 0, 0);
      for (const resource of resources) {
        await resource.release();
      }
    },
  };
}

function initialize(execution: ReturnType<typeof capture>, sessionId: string, key = sessionId) {
  return execution.runExisting(source, (scope) =>
    scope.execute({
      type: "session.transcript.initialize",
      input: { sessionKey: `agent:first:${key}`, sessionId },
    }),
  );
}

it("recovers after a full agent database write settles", async () => {
  const env = makeEnv();
  const execution = capture(env);
  await execution.prepare(source);
  const context = captureOpenClawStateWorkerContext({ env });
  const idleLease = createOpenClawStateWorkerLease(context);
  await using _ = releaseOnExit(idleLease, execution);
  await idleLease.ready;
  Atomics.store(faultState, 0, 6);
  const sharedFailure: unknown = await executeOpenClawStateWorker(context, {
    type: "capture.persistPayload",
    input: { data: randomBytes(1_000_000), contentType: "application/octet-stream" },
  }).catch((error: unknown) => error);
  expect(sharedFailure).toMatchObject({ code: "outcome-unknown" });
  Atomics.store(faultState, 0, 5);
  const failure: unknown = await initialize(execution, "full".repeat(100_000), "full").catch(
    (error: unknown) => error,
  );
  Atomics.store(faultState, 0, 0);
  expect(failure).toMatchObject({ code: "outcome-unknown" });
  const recovered = capture(env);
  try {
    await expect(initialize(recovered, "recovered")).resolves.toMatchObject({
      kind: "session-transcript-initialized",
    });
    expect(Atomics.load(faultState, 3)).toBe(2);
  } finally {
    await recovered.release();
  }
});

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
    await using _ = releaseOnExit(execution);
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
  },
);

function executionSource(
  observe?: (authority: SqliteWorkerExecutionAuthority) => void,
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent: () => undefined,
    createAdmission: (binding) => () => {
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
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

it("does not fence an actor when its worker stops before command admission", async () => {
  const env = makeEnv();
  const execution = capture(env);
  await execution.prepare(source);
  const identity = execution.fileIdentity;
  if (!identity) {
    throw new Error("Actor recovery fixture requires its prepared database identity");
  }
  const sessionKey = "agent:first:pre-admission-recovery";
  const scope = {
    agentId: "first",
    storePath: execution.path,
    sessionKey,
    sessionId: "actor-recovery",
  };
  const actor = await createSessionActorFactory({
    agentId: "first",
    env,
    path: execution.path,
  }).acquire({ database: identity, sessionKey }, { assertCurrent() {}, assertReadable() {} });
  const authorize = vi.fn();
  const authority = { assertCurrent() {}, authorize };
  await using _ = releaseOnExit(actor, execution);
  await expect(
    actor.appendTranscriptEvent(
      {
        commandId: "initial-message",
        phaseId: "setup",
        append: {
          kind: "message",
          input: {
            scope,
            cwd: "/synthetic",
            messageJson: JSON.stringify({ role: "user", content: "hello" }),
          },
          initialization: { scope, entry: { sessionId: scope.sessionId, updatedAt: 1 } },
        },
      },
      authority,
    ),
  ).resolves.toMatchObject({ kind: "committed" });
  authorize.mockClear();
  Atomics.store(faultState, 0, 2);
  const failed = await actor.patch(
    {
      commandId: fault.marker,
      phaseId: "before-admission",
      reducers: [{ kind: "activity", updatedAt: 2 }],
    },
    authority,
  );
  Atomics.store(faultState, 0, 0);
  expect(authorize).not.toHaveBeenCalled();
  expect(failed).toMatchObject({ kind: "rolled-back" });
  expect(await readEntries(execution, sessionKey)).toMatchObject({
    entries: [{ sessionKey, entry: { updatedAt: 1 } }],
  });
  await expect(
    actor.patch(
      {
        commandId: "after-worker-restart",
        phaseId: "recovery",
        reducers: [{ kind: "activity", updatedAt: 3 }],
      },
      authority,
    ),
  ).resolves.toMatchObject({ kind: "committed" });
  expect(await readEntries(execution, sessionKey)).toMatchObject({
    entries: [{ sessionKey, entry: { updatedAt: 3 } }],
  });
});

function readEntries(
  execution: ReturnType<typeof capture>,
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
  const claimFailure = () => {
    try {
      claim.assertCurrent();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  expect(isSqliteWorkerError(claimFailure(), "unavailable")).toBe(true);

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
  expect(isSqliteWorkerError(claimFailure(), "unavailable")).toBe(true);
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
  expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cause: expect.any(AggregateError) });
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

it("keeps unavailable cleanup failures outside retry handling while preserving their primary outcome", async () => {
  const execution = capture(makeEnv());
  await execution.prepare(source);
  const primary = new SqliteWorkerError("synthetic unavailable operation", "unavailable");
  const operation = vi.fn(async (scope: AgentDatabaseExecutionScope) => {
    await scope
      .execute({ type: "session.entry.read", input: { sessionKeys: [fault.marker] } })
      .catch(() => {
        throw primary;
      });
  });
  Atomics.store(faultState, 0, 1);
  await using _ = releaseOnExit(execution);
  const failure: unknown = await execution
    .runExisting(source, operation)
    .catch((error: unknown) => error);
  expect(operation).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({
    cause: expect.objectContaining({ cause: primary, errors: [primary, expect.any(Error)] }),
  });
  expect(classifyGatewayStorageFailure(failure)).toBe("unavailable");
  expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(false);
  expect(isSqliteWorkerError(failure, "unavailable")).toBe(false);
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
  const observed = probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      !survivors &&
      request.stage === "open" &&
      isRecord(request.facts) &&
      request.facts.databasePath === refused.path
    ) {
      survivors = Promise.allSettled(admitted.map((survivor) => readEntries(survivor, [])));
    }
    admit(request, grant);
  });
  try {
    await expect(refused.prepare(source)).rejects.toThrow("agent removed is deleted");
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
    observed.mockRestore();
    await Promise.allSettled([
      retained.release(),
      refused.release(),
      ...peers.map((peer) => peer.release()),
    ]);
  }
});
