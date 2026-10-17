import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  revokeSqliteDatabaseAdmissionsForPath,
  readSqliteDatabaseIntegrityVerification,
  readSqliteDatabaseCleanClose,
} from "../infra/sqlite-database-admission.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "./openclaw-agent-db-identity.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeCachedOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "./openclaw-agent-db-registry-listing.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { removeAgentIntegrityMetadataForTest } from "./openclaw-agent-db.test-support.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { AgentDatabaseExecutionLifetime } from "./openclaw-agent-execution-authority.js";
import type { AgentDatabaseExecutionScope } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import {
  captureOpenClawAgentDatabaseExecution,
  getPendingOpenClawAgentDatabasePreparation,
} from "./openclaw-agent-execution.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import * as stateWorkerStore from "./openclaw-state-worker-store.js";

const counter = vi.hoisted(() => ({
  path: "",
  checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
  gate: undefined as SharedArrayBuffer | undefined,
}));
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      const match = /^PRAGMA (integrity_check|foreign_key_check)(?:[(]'sqlite_schema'[)])?;?$/i.exec(sql.trim());
      if (this.location() === workerData.testIntegrityPath && match) {
        for (const method of ["all", "get", "iterate", "run"]) {
          const execute = statement[method].bind(statement);
          statement[method] = (...args) => {
            if (workerData.testIntegrityGate) {
              const gate = new Int32Array(workerData.testIntegrityGate);
              Atomics.store(gate, 1, 1);
              Atomics.notify(gate, 1);
              while (Atomics.load(gate, 0) === 1) Atomics.wait(gate, 0, 1);
            }
            Atomics.add(new Int32Array(workerData.testIntegrityChecks),
              match[1].toLowerCase() === "integrity_check" ? 0 : 1, 1);
            return execute(...args);
          };
        }
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          testIntegrityPath: counter.path,
          testIntegrityChecks: counter.checks,
          testIntegrityGate: counter.gate,
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

// Direct native fixtures hold their generation until their explicit close.
function createNativeGeneration(
  agentId: string,
  pathname: string,
  context: ReturnType<typeof captureOpenClawStateWorkerContext>,
  assertCurrent: () => void,
  assertCleanup = assertCurrent,
) {
  return createAgentDatabaseNativeGeneration(
    agentId,
    pathname,
    context,
    new AgentDatabaseExecutionLifetime().state,
    assertCurrent,
    assertCleanup,
    undefined,
    () => {},
    () => {},
  );
}

function createNativeSource(assertCurrent: () => void): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assertCurrent();
        if (!grant()) {
          throw new Error("Native integrity fixture lost its retained admission");
        }
      }, binding.attachment),
    }),
  };
}

it.for(["revoked", "aborted"] as const)(
  "keeps shared integrity preparation alive after its initiating caller is %s",
  async (cancellation, { signal }) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-stale-shared-")) };
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    const stale = claimOpenClawAgentDatabaseLease({ ...options, path: database.path });
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_start_time = -1 WHERE lease_id = ?")
      .run(stale);
    closeOpenClawAgentDatabaseByPath(database.path);
    invalidateOpenClawAgentDatabaseValidation(database.path);
    revokeSqliteDatabaseAdmissionsForPath(database.path);
    expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);

    counter.path = database.path;
    counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    Atomics.store(gate, 0, 1);
    counter.gate = gate.buffer;
    const initiator = captureOpenClawAgentDatabaseExecution(options);
    const borrowers = [
      initiator,
      ...Array.from({ length: 2 }, () => captureOpenClawAgentDatabaseExecution(options)),
    ];
    const source = createNativeSource(() => {});
    const retainedRegistry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env }, () => false);
    const controller = new AbortController();
    let initiatingCallerCurrent = true;
    const refused = new Error("Initiating caller cancelled after integrity started");
    const initiatingSource = createNativeSource(() => {
      controller.signal.throwIfAborted();
      if (!initiatingCallerCurrent) {
        throw refused;
      }
    });
    const initialize = (scope: AgentDatabaseExecutionScope, sessionId: string) =>
      scope.execute({
        type: "session.transcript.initialize",
        input: { sessionKey: `agent:main:${sessionId}`, sessionId },
      });
    const initiatingOperation = vi.fn((scope: AgentDatabaseExecutionScope) =>
      initialize(scope, "initiator"),
    );
    const initiating =
      cancellation === "aborted"
        ? initiator.prepare(initiatingSource, controller.signal)
        : initiator.runExisting(initiatingSource, initiatingOperation);
    void initiating.catch(() => {});
    let peers: Promise<unknown>[] = [];
    try {
      await withinTest(Promise.resolve(Atomics.waitAsync(gate, 1, 0).value), signal);
      if (cancellation === "aborted") {
        controller.abort(refused);
        await expect(initiating).rejects.toBe(refused);
        // Discovery still joins physical preparation after its only waiter leaves.
        expect(getPendingOpenClawAgentDatabasePreparation(database.path)).toBeDefined();
      } else {
        initiatingCallerCurrent = false;
      }
      peers = borrowers.slice(1).map((borrower, index) => {
        const registry =
          index === 0
            ? retainedRegistry
            : prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env }, () => false);
        return borrower.runExisting(
          {
            ...createNativeSource(() => registry.assertCurrent()),
            onRegistryChange: registry.followRegistration,
          },
          (scope) => initialize(scope, `peer-${index}`),
        );
      });
      void Promise.allSettled(peers);
    } finally {
      Atomics.store(gate, 0, 0);
      Atomics.notify(gate, 0);
      counter.gate = undefined;
    }
    try {
      expect(await Promise.allSettled(peers)).toEqual([
        {
          status: "fulfilled",
          value: expect.objectContaining({
            kind: "session-transcript-initialized",
            sessionKey: "agent:main:peer-0",
          }),
        },
        {
          status: "fulfilled",
          value: expect.objectContaining({
            kind: "session-transcript-initialized",
            sessionKey: "agent:main:peer-1",
          }),
        },
      ]);
      await expect(initiating).rejects.toBe(refused);
      expect(initiatingOperation).not.toHaveBeenCalled();
      await expect(initiator.runExisting(initiatingSource, initiatingOperation)).rejects.toBe(
        refused,
      );
      expect(Array.from(new Int32Array(counter.checks))).toEqual([1, 1]);
    } finally {
      await Promise.all(borrowers.map((borrower) => borrower.release()));
    }
    await closeOpenClawAgentDatabasesAsync();
    using persisted = openNodeSqliteDatabase(database.path, { readOnly: true });
    expect(
      persisted
        .prepare("SELECT session_key, current_session_id FROM session_nodes ORDER BY session_key")
        .all(),
    ).toEqual([
      { session_key: "agent:main:peer-0", current_session_id: "peer-0" },
      { session_key: "agent:main:peer-1", current_session_id: "peer-1" },
    ]);
    const reopened = createNativeGeneration(
      database.agentId,
      database.path,
      captureOpenClawStateWorkerContext({ env }),
      () => {},
    );
    try {
      expect(await reopened.run(source, async () => "reopened")).toBe("reopened");
      expect(Array.from(new Int32Array(counter.checks))).toEqual([1, 1]);
    } finally {
      await reopened.close();
    }
  },
);

it.for(["warm", "cold"] as const)(
  "admits durable channel messages while agent integrity is pending (%s shared writer)",
  async (sharedWriter, { signal }) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-ingress-isolation-")) };
    const ready = openOpenClawAgentDatabase({ agentId: "ready", env });
    const preparing = openOpenClawAgentDatabase({ agentId: "preparing", env });
    const context = captureOpenClawStateWorkerContext({ env });
    const assertCurrent = () => context.admission.assertCurrent();
    const source = createNativeSource(assertCurrent);
    const readyGeneration = createNativeGeneration(
      ready.agentId,
      ready.path,
      context,
      assertCurrent,
    );
    const preparingGeneration = createNativeGeneration(
      preparing.agentId,
      preparing.path,
      context,
      assertCurrent,
    );
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "synthetic",
      stateDir: env.OPENCLAW_STATE_DIR,
    });
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    Atomics.store(gate, 0, 1);
    counter.path = preparing.path;
    counter.gate = gate.buffer;
    invalidateOpenClawAgentDatabaseValidation(preparing.path);
    let preparation: Promise<unknown> | undefined;
    try {
      // Occupy both ordinary slots on the old implementation before opening the slow agent.
      if (sharedWriter === "warm") {
        await queue.enqueue("before", { text: "before preparation" });
      }
      await readyGeneration.run(source, async () => {});
      preparation = preparingGeneration.run(source, async () => {});
      void preparation.catch(() => {});
      await withinTest(Promise.resolve(Atomics.waitAsync(gate, 1, 0).value), signal);

      await withinTest(queue.enqueue("during", { text: "during preparation" }), signal);
      expect(Atomics.load(gate, 0)).toBe(1);
      expect((await queue.listPending()).map((event) => event.id)).toEqual(
        sharedWriter === "warm" ? ["before", "during"] : ["during"],
      );
    } finally {
      Atomics.store(gate, 0, 0);
      Atomics.notify(gate, 0);
      counter.gate = undefined;
      await preparation;
      await preparingGeneration.close();
      await readyGeneration.close();
    }
  },
);

it.each(["confirmed close", "native exit"] as const)(
  "uses native close evidence before recovering an agent lease (%s)",
  async (outcome) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-native-close-") };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const shared = openOpenClawStateDatabase({ env });
    const leases = () =>
      shared.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
        .all(database.path);
    const hostLeases = leases();
    expect(hostLeases).toHaveLength(1);
    const context = captureOpenClawStateWorkerContext({ env });
    const assertCurrent = () => context.admission.assertCurrent();
    const source = createNativeSource(assertCurrent);
    const generation = createNativeGeneration(
      database.agentId,
      database.path,
      context,
      assertCurrent,
    );
    const workers: Worker[] = [];
    const observeWorker = (worker: Worker) => workers.push(worker);
    const cleanup = vi.spyOn(stateWorkerStore, "openOpenClawStateWorkerCleanupStore");
    process.on("worker", observeWorker);
    try {
      await expect(generation.run(source, async () => "opened")).resolves.toBe("opened");
      expect(leases()).toHaveLength(2);
      const validation = getOpenClawAgentDatabaseValidation(database);
      assert(validation, "native generation must publish validation before retirement");
      process.off("worker", observeWorker);
      if (outcome === "native exit") {
        expect(workers.length).toBeGreaterThan(0);
        await Promise.all(workers.map((worker) => worker.terminate()));
        expect(leases()).toHaveLength(2);
        expect(cleanup).not.toHaveBeenCalled();
        expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(0);
        expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
      }
      await generation.close();
      expect(leases()).toEqual(hostLeases);
      expect(cleanup).toHaveBeenCalledTimes(outcome === "confirmed close" ? 0 : 1);
      if (outcome === "confirmed close") {
        expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
      }
    } finally {
      process.off("worker", observeWorker);
      try {
        await generation.close();
      } finally {
        cleanup.mockRestore();
      }
    }
  },
);

it("retires every borrower when native open refusal retains admission cleanup failure", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-open-cleanup-")) };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const rejected = captureOpenClawAgentDatabaseExecution(options);
  const retained = captureOpenClawAgentDatabaseExecution(options);
  const refusal = new Error("Physical owner refused native agent open");
  const cleanupError = new Error("Physical owner cleanup failed after granting open");
  let nativeCurrent = true;
  let domainOpenRequests = 0;
  const source = createNativeSource(() => {});
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const fault = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) => {
      if (!isRecord(attachment) || attachment.kind !== "agent-execution") {
        return createAdmission(admit, attachment);
      }
      return createAdmission((request, grant) => {
        if (!nativeCurrent) {
          throw refusal;
        }
        if (request.stage === "open") {
          domainOpenRequests += 1;
        }
        admit(request, grant);
        if (request.stage === "open" && domainOpenRequests === 1) {
          // The broker granted factory entry; the factory must still admit its native open.
          nativeCurrent = false;
          throw cleanupError;
        }
      }, attachment);
    });
  try {
    const opening = rejected.runExisting(source, async () => "not admitted");
    await expect(opening).rejects.toBeInstanceOf(AggregateError);
    await expect(opening).rejects.toMatchObject({
      cause: refusal,
      errors: [refusal, { errors: [cleanupError] }],
    });
    // Physical-owner refusal precedes the second domain admission.
    expect(domainOpenRequests).toBe(1);
    nativeCurrent = true;
    expect(() => retained.assertCurrent()).toThrow("Agent database execution admission is closed");
    await expect(retained.runExisting(source, async () => "not admitted")).rejects.toThrow(
      "Agent database execution admission is closed",
    );
  } finally {
    fault.mockRestore();
    nativeCurrent = true;
    const released = await Promise.allSettled([rejected.release(), retained.release()]);
    await closeOpenClawAgentDatabasesAsync();
    expect(released).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  }
});

it("retires every borrower when native opening reports a protocol failure", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-open-protocol-")) };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const rejected = captureOpenClawAgentDatabaseExecution(options);
  const retained = captureOpenClawAgentDatabaseExecution(options);
  const source = createNativeSource(() => {});
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const fault = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) => {
      const admission = createAdmission(admit, attachment);
      if (isRecord(attachment) && attachment.kind === "agent-execution") {
        admission.port.postMessage(
          { kind: "native-settlement", settlement: { kind: "invalid" } },
          [],
        );
        admission.service();
      }
      return admission;
    });
  const operation = vi.fn(async () => "not admitted");
  try {
    await expect(rejected.runExisting(source, operation)).rejects.toThrow(
      "SQLite worker native settlement is invalid",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(() => retained.assertCurrent()).toThrow("Agent database execution admission is closed");
    await expect(retained.runExisting(source, operation)).rejects.toThrow(
      "Agent database execution admission is closed",
    );
    expect(operation).not.toHaveBeenCalled();
  } finally {
    fault.mockRestore();
    const released = await Promise.allSettled([rejected.release(), retained.release()]);
    expect(released).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  }
});

it.each(["settled", "pending"] as const)(
  "prepares missing storage after an existing-only miss (%s)",
  async (timing) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-prepare-missing-")) };
    const execution = captureOpenClawAgentDatabaseExecution({ agentId: "main", env });
    const source = createNativeSource(() => execution.assertCurrent());
    try {
      const missing = execution.runExisting(source, async () => "unexpected");
      if (timing === "settled") {
        expect(await missing).toBeUndefined();
      }
      const preparing = execution.prepare(source);
      expect(await missing).toBeUndefined();
      await preparing;
      expect(fs.existsSync(execution.path)).toBe(true);
      expect(await execution.runExisting(source, async () => "opened")).toBe("opened");
    } finally {
      await execution.release();
    }
  },
);

it("opens an unconfigured external store without reconstructing unknown deletion history", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-worker-missing-history-") };
  const external = tempDirs.make("agent-worker-external-history-");
  const pathname = path.join(external, "retained.sqlite");
  const retained = openOpenClawAgentDatabase({
    agentId: "main",
    path: pathname,
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-worker-fixture-owner-") },
  });
  retained.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
  closeOpenClawAgentDatabaseByPath(pathname);
  const bytes = fs.readFileSync(pathname);
  const context = captureOpenClawStateWorkerContext({ env });
  const assertCurrent = () => context.admission.assertCurrent();
  const source = createNativeSource(assertCurrent);
  const generation = createNativeGeneration("main", pathname, context, assertCurrent);
  const opening = await Promise.allSettled([generation.run(source, async () => "opened")]);
  const closing = await Promise.allSettled([generation.close()]);
  expect(opening).toEqual([{ status: "fulfilled", value: "opened" }]);
  expect(closing).toEqual([{ status: "fulfilled", value: undefined }]);
  expect(fs.readFileSync(pathname)).toEqual(bytes);
  expect(fs.readdirSync(external).toSorted()).toEqual(["retained.sqlite", "retained.sqlite.seal"]);
  const shared = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), { readOnly: true });
  try {
    expect(
      shared.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'").get(),
    ).toBeUndefined();
  } finally {
    shared.close();
  }
});

it.each([
  "verified",
  "two-leases",
  "two-leases-missing-metadata",
  "two-leases-stale",
  "two-leases-unknown-owner",
  "two-leases-unclean",
  "prepared-existing",
  "invalidated",
  "failed",
  "revoked-before-grant",
  "revoked-after-verification-admission",
  "missing-metadata",
  "closed-host",
  "closed-host-blocked",
  "closed-host-blocked-last",
  "closed-host-revoked",
  "closed-host-replaced",
  "closed-host-no-receipt",
  "closed-host-no-receipt-rollback",
] as const)("native execution borrows only current host integrity proof (%s)", async (proof) => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-native-integrity-")) };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
  const verifiedAt = readSqliteDatabaseIntegrityVerification(database.path)?.verifiedAt;
  expect(verifiedAt).toBeDefined();
  counter.path = database.path;
  counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const context = captureOpenClawStateWorkerContext({ env });
  const closedHost = proof.startsWith("closed-host");
  const missingReceipt = proof.startsWith("closed-host-no-receipt");
  const siblingLease =
    (closedHost && !missingReceipt && proof !== "closed-host-blocked-last") ||
    proof.startsWith("two-leases")
      ? claimOpenClawAgentDatabaseLease({ agentId: database.agentId, path: database.path, env })
      : undefined;
  if (proof === "two-leases") {
    expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
  }
  if (proof === "two-leases-missing-metadata") {
    removeAgentIntegrityMetadataForTest(database.path);
  }
  if (proof === "two-leases-stale" || proof === "two-leases-unknown-owner") {
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_start_time = ? WHERE lease_id = ?")
      .run(proof === "two-leases-stale" ? -1 : null, siblingLease!);
  } else if (proof === "two-leases-unclean") {
    releaseOpenClawAgentDatabaseLease(siblingLease!, { env });
  }
  const claim: OpenClawAgentDatabaseClaim | undefined = closedHost
    ? undefined
    : createOpenClawAgentDatabaseClaim(database, retainAgentDatabase(database.db));
  if (proof === "closed-host-blocked" || proof === "closed-host-blocked-last") {
    database.db.exec("INSERT INTO auth_profile_state VALUES ('checkpoint', '{}', 1)");
    const reader = openNodeSqliteDatabase(database.path, { readOnly: true });
    try {
      reader.exec("BEGIN");
      reader
        .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='checkpoint'")
        .get();
      database.db.exec("UPDATE auth_profile_state SET updated_at=2 WHERE state_key='checkpoint'");
      closeCachedOpenClawAgentDatabase(database);
      expect(database.db.isOpen).toBe(false);
      expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
    } finally {
      reader.close();
    }
  } else if (closedHost) {
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  if (missingReceipt) {
    clearOpenClawAgentDatabaseValidationCache(database.path);
    revokeSqliteDatabaseAdmissionsForPath(database.path);
    if (proof === "closed-host-no-receipt-rollback") {
      using writer = openNodeSqliteDatabase(database.path);
      writer.exec("PRAGMA journal_mode=DELETE");
    }
  }
  const assertCurrent = () => {
    claim?.assertCurrent();
    context.admission.assertCurrent();
  };
  let revokedBeforeGrant = false;
  let revokedAfterVerificationAdmission = false;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (
            proof === "revoked-before-grant" &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "shared-owner"
          ) {
            // Revoke the already-sent proof while the native opener still awaits its grant.
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revokedBeforeGrant = true;
          }
          if (
            proof === "revoked-after-verification-admission" &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "agent-validation-start"
          ) {
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revokedAfterVerificationAdmission = true;
          }
          if (!grant()) {
            throw new Error("Native integrity fixture lost its retained admission");
          }
        }, binding.attachment),
      });
    },
  };
  const generation = createNativeGeneration(
    database.agentId,
    database.path,
    context,
    assertCurrent,
  );
  if (
    proof === "invalidated" ||
    proof === "closed-host-revoked" ||
    proof === "revoked-after-verification-admission"
  ) {
    invalidateOpenClawAgentDatabaseValidation(database.path);
  } else if (proof === "closed-host-replaced") {
    fs.copyFileSync(database.path, `${database.path}.replacement`);
    fs.renameSync(`${database.path}.replacement`, database.path);
  } else if (proof === "failed") {
    recordOpenClawAgentDatabaseOpenFailure(database.path, new Error("Synthetic host failure"));
  } else if (proof === "missing-metadata") {
    invalidateOpenClawAgentDatabaseValidation(database.path);
    revokeSqliteDatabaseAdmissionsForPath(database.path);
  }
  try {
    if (proof === "revoked-after-verification-admission") {
      const operation = vi.fn(async () => "not admitted");
      await expect(generation.run(source, operation)).rejects.toThrow(
        "Agent schema admission changed before publication",
      );
      expect(revokedAfterVerificationAdmission).toBe(true);
      expect(Array.from(new Int32Array(counter.checks))).toEqual([1, 1]);
      expect(operation).not.toHaveBeenCalled();
      return;
    }
    if (proof === "failed") {
      await expect(generation.run(source, async () => "opened")).rejects.toThrow(
        "OpenClaw agent database claim is no longer current",
      );
      expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
      expect(Array.from(new Int32Array(counter.checks))).toEqual([0, 0]);
      return;
    }
    await expect(
      generation.run(source, async () => "opened", undefined, proof === "prepared-existing"),
    ).resolves.toBe("opened");
    expect(Array.from(new Int32Array(counter.checks))).toEqual(
      proof === "verified" ||
        proof === "prepared-existing" ||
        proof === "closed-host" ||
        proof === "closed-host-blocked" ||
        proof === "closed-host-blocked-last" ||
        proof === "two-leases" ||
        proof === "two-leases-unknown-owner" ||
        proof === "two-leases-missing-metadata"
        ? [0, 0]
        : [1, 1],
    );
    expect(revokedBeforeGrant).toBe(proof === "revoked-before-grant");
  } finally {
    try {
      await generation.close();
    } finally {
      claim?.release();
      if (siblingLease) {
        releaseOpenClawAgentDatabaseLease(siblingLease, { env }, "read-only");
      }
    }
  }
  if (proof === "closed-host-blocked-last") {
    expect(readSqliteDatabaseCleanClose(database.path)).toBe(true);
    expect(readSqliteDatabaseIntegrityVerification(database.path)?.verifiedAt).toBe(verifiedAt);
  }
});

it.runIf(process.platform === "linux")(
  "fully verifies killed owners before writing, regardless of WAL state or lease provenance",
  async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-process-death-") };
    const cases = [
      "same-boot",
      "checkpointed-wal",
      "foreign-boot",
      "legacy-lease",
      "pid-reused",
      "dirty-receipt",
      "corrupt-page",
      "interrupted-admission",
    ];
    const childUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.agentDatabaseCrash);
    const child = fork(fileURLToPath(childUrl), cases, {
      execArgv: resolveRuntimeWorkerArgv(childUrl).slice(0, -1),
      env: { ...process.env, ...env },
      silent: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    type Fixture = { agentId: string; path: string; corruptionOffset: number };
    let fixtures: Fixture[];
    try {
      fixtures = await new Promise<Fixture[]>((resolve, reject) => {
        const failed = () => reject(new Error(`Crash fixture exited before opening: ${stderr}`));
        child.once("error", reject);
        child.once("exit", failed);
        child.once("message", (message) => {
          child.off("exit", failed);
          resolve(message as Fixture[]);
        });
      });
    } finally {
      await stopChildProcess(child, 5_000, { force: true });
    }
    expect(child.signalCode).toBe("SIGKILL");
    expect(fixtures.map((fixture) => fixture.agentId)).toEqual(cases);
    const shared = openOpenClawStateDatabase({ env });
    for (const fixture of fixtures) {
      const { agentId, path: pathname } = fixture;
      const held = shared.db
        .prepare(
          "SELECT lease_id, provenance, owner_pid, owner_start_time FROM agent_database_leases WHERE path=?",
        )
        .get(pathname);
      expect(held).toMatchObject({
        lease_id: expect.stringMatching(/^[a-f0-9-]+$/u),
        provenance: expect.stringMatching(/^process-v1:[a-f0-9]{64}$/u),
        owner_pid: child.pid,
        owner_start_time: expect.any(Number),
      });
      if (agentId === "interrupted-admission") {
        expect(readSqliteDatabaseIntegrityVerification(pathname)).toBeUndefined();
      } else {
        expect(readSqliteDatabaseCleanClose(pathname)).toBe(false);
      }
      if (agentId === "checkpointed-wal") {
        expect(fs.statSync(`${pathname}-wal`).size).toBe(0);
      } else {
        expect(fs.statSync(`${pathname}-wal`).size).toBeGreaterThan(32);
      }
      if (agentId === "foreign-boot" || agentId === "corrupt-page") {
        shared.db
          .prepare("UPDATE agent_database_leases SET provenance=? WHERE path=?")
          .run(`process-v1:${"0".repeat(64)}`, pathname);
      } else if (agentId === "legacy-lease") {
        shared.db
          .prepare("UPDATE agent_database_leases SET provenance=NULL WHERE path=?")
          .run(pathname);
      } else if (agentId === "pid-reused") {
        shared.db
          .prepare("UPDATE agent_database_leases SET owner_pid=?, owner_start_time=-1 WHERE path=?")
          .run(process.pid, pathname);
      } else if (agentId === "dirty-receipt") {
        shared.db.prepare("DELETE FROM agent_database_leases WHERE path=?").run(pathname);
      }
      if (agentId === "corrupt-page") {
        const file = fs.openSync(pathname, "r+");
        try {
          // This checkpointed table has no newer WAL image to hide the invalid btree page.
          fs.writeSync(file, Buffer.from([0]), 0, 1, fixture.corruptionOffset);
        } finally {
          fs.closeSync(file);
        }
      }

      counter.path = pathname;
      counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const context = captureOpenClawStateWorkerContext({ env });
      const assertCurrent = () => {
        context.admission.assertCurrent();
        assertAgentDatabaseAdmitted(agentId, { env });
      };
      const source = createNativeSource(assertCurrent);
      const generation = createNativeGeneration(agentId, pathname, context, assertCurrent, () =>
        context.admission.assertCurrent(),
      );
      try {
        if (agentId === "corrupt-page") {
          await expect(generation.run(source, async () => "opened")).rejects.toThrow(
            /integrity|malformed|corrupt/i,
          );
          expect(Atomics.load(new Int32Array(counter.checks), 0)).toBeGreaterThan(0);
          continue;
        }
        const sessionKey = `agent:${agentId}:after-crash`;
        const initialize = async () => {
          await expect(
            generation.run(source, (scope) => {
              expect(Array.from(new Int32Array(counter.checks)), agentId).toEqual([1, 1]);
              return scope.execute({
                type: "session.transcript.initialize",
                input: { sessionKey, sessionId: "after-crash" },
              });
            }),
          ).resolves.toMatchObject({ kind: "session-transcript-initialized", sessionKey });
        };
        await initialize();
        expect(Array.from(new Int32Array(counter.checks)), agentId).toEqual([1, 1]);
        expect(readSqliteDatabaseIntegrityVerification(pathname)).toEqual({
          verifiedAt: expect.any(Number),
        });
      } finally {
        await generation.close();
      }
      expect(readSqliteDatabaseCleanClose(pathname)).toBe(true);
      using reopened = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(reopened.prepare("SELECT store_json FROM auth_profile_store").all()).toEqual([
        { store_json: '{"ok":true}' },
      ]);
      expect(reopened.prepare("SELECT state_key FROM auth_profile_state").all()).toEqual([
        { state_key: "committed-wal" },
      ]);
    }
  },
);

it("settles peer native leases when close revokes a shared worker's opening executor", async () => {
  const fixture = () => ({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-peers-")) },
  });
  const source = createNativeSource(() => {});
  const peers = [];
  const options = [];
  // Retained agents share broker workers with the next native opener.
  for (let index = 0; index < 4; index += 1) {
    const target = fixture();
    options.push(target);
    const peer = captureOpenClawAgentDatabaseExecution(target);
    await peer.prepare(source);
    peers.push(peer);
  }
  const target = fixture();
  options.push(target);
  const execution = captureOpenClawAgentDatabaseExecution(target);
  let closing: Promise<void> | undefined;
  const preparing = execution.prepare({
    ...source,
    createAdmission(binding) {
      return source.createAdmission({
        ...binding,
        authorize(request) {
          if (
            !closing &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "agent-open-resume"
          ) {
            closing = closeOpenClawAgentDatabasesAsync();
            void closing.catch(() => {});
          }
          binding.authorize(request);
        },
      });
    },
  });
  try {
    await expect(preparing).rejects.toThrow("Agent database execution admission is closed");
    expect(closing).toBeDefined();
    await closing;
    for (const owner of options) {
      expect(
        openOpenClawStateDatabase({ env: owner.env })
          .db.prepare("SELECT lease_id FROM agent_database_leases")
          .all(),
      ).toEqual([]);
    }
  } finally {
    await Promise.allSettled([
      preparing,
      closing,
      execution.release(),
      ...peers.map((peer) => peer.release()),
    ]);
  }
});
