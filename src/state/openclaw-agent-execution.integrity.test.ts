import { AsyncLocalStorage } from "node:async_hooks";
import { fork } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveRequestedSessionAgentId } from "../gateway/session-request-agent.js";
import { withGatewaySessionEntry as withEntry } from "../gateway/session-utils-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  revokeSqliteDatabaseAdmissionsForPath,
  readSqliteDatabaseIntegrityVerification,
  readSqliteDatabaseCleanClose,
} from "../infra/sqlite-database-admission.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as sqliteWorkerStore from "../infra/sqlite-worker-store.js";
import {
  assertAgentDatabaseAdmitted,
  captureAgentDatabaseAdmission,
  isAgentDatabaseStartupReadReady,
  readAgentDatabaseReadAdmissionRefusal,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { retainAgentDatabase } from "./openclaw-agent-db-borrower.js";
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
} from "./openclaw-agent-db-lifecycle.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "./openclaw-agent-db-registry-listing.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation as getValidation,
  invalidateOpenClawAgentDatabaseValidation as invalidateValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPath as closeAgent,
  openOpenClawAgentDatabase as openAgent,
} from "./openclaw-agent-db.js";
import { removeAgentIntegrityMetadataForTest } from "./openclaw-agent-db.test-support.js";
import type { AgentDatabaseExecutionScope } from "./openclaw-agent-execution-contract.js";
import {
  createNativeIntegrityGeneration as nativeGeneration,
  createNativeIntegritySource as sourceFor,
} from "./openclaw-agent-execution-native.test-support.js";
import {
  captureOpenClawAgentDatabaseExecution as capture,
  getPendingOpenClawAgentDatabasePreparation,
  prepareOpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { withOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext as workerContext } from "./openclaw-state-worker-context.js";
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
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

const makeEnv = (prefix: string) => ({
  OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make(prefix)),
});
const checks = () => Array.from(new Int32Array(counter.checks));
const initialized = (scope: AgentDatabaseExecutionScope, sessionId: string, agentId = "main") =>
  scope.execute({
    type: "session.transcript.initialize",
    input: { sessionKey: `agent:${agentId}:${sessionId}`, sessionId },
  });

function holdIntegrity(pathname: string) {
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  Atomics.store(gate, 0, 1);
  counter.path = pathname;
  counter.gate = gate.buffer;
  return {
    gate,
    entered: () => Promise.resolve(Atomics.waitAsync(gate, 1, 0).value),
    release() {
      Atomics.store(gate, 0, 0);
      Atomics.notify(gate, 0);
      counter.gate = undefined;
    },
  };
}

it.for(["valid", "invalid-row", "missing-index", "failed", "stopped", "superseded"] as const)(
  "serves inspected startup snapshots while native integrity is held (%s)",
  async (contents, { signal }) => {
    const env = makeEnv("startup-early-read-");
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const scope = { agentId: "main", env, sessionKey: "agent:main:retained" };
    const entry = await replaceSessionEntry(scope, { sessionId: "retained", updatedAt: 1 });
    const pathname = openAgent(scope).path;
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    {
      using db = openNodeSqliteDatabase(pathname);
      db.exec("UPDATE session_key_contract SET canonical_ready=NULL");
      if (contents === "invalid-row") {
        db.exec("UPDATE session_nodes SET parent_session_key='main'");
      } else if (contents === "missing-index") {
        db.exec("DROP INDEX idx_agent_session_nodes_active");
      }
    }
    invalidateValidation(pathname);
    revokeSqliteDatabaseAdmissionsForPath(pathname);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      await withOpenClawStateDatabaseReadSnapshot(
        () => assertOpenClawDatabasesReady({ env, config, operation: "gateway-startup" }),
        { env },
      );
      const owner = admission.adopt();
      const integrity = holdIntegrity(pathname);
      let current = true;
      const assertWrite = captureAgentDatabaseAdmission("main", { env });
      let publicationWrite = assertWrite;
      const phases: string[] = [];
      try {
        admission.activate({
          isCurrent: () => current,
          preparationReady: Promise.resolve(),
          captureReadAdmission: ({ assertCurrent }) => assertCurrent,
          openAgent: ({ assertCurrent, signal: openingSignal }) => {
            phases.push("open");
            return prepareOpenClawAgentDatabaseExecution(scope, assertCurrent, openingSignal);
          },
          migrateAgent: async () => {
            phases.push("migration");
            if (contents === "failed") {
              throw new Error("synthetic preparation failure");
            }
          },
          publishAgent: async () => {
            if (contents !== "missing-index") {
              expect(readAgentDatabaseReadAdmissionRefusal("main", { env })).toBeUndefined();
              expect(assertWrite).toThrow("startup inspection");
              const publicationContext = AsyncLocalStorage.snapshot();
              publicationWrite = () => publicationContext(assertWrite);
              await Promise.resolve().then(() =>
                expect(publicationWrite).toThrow("startup inspection"),
              );
            }
            phases.push("publication");
          },
        });
        await withinTest(integrity.entered(), signal);
        const resolved = resolveRequestedSessionAgentId(config, scope.sessionKey, "main", "read");
        expect(resolved).toMatchObject(
          contents === "missing-index"
            ? { ok: false, error: { code: "UNAVAILABLE" } }
            : { ok: true, agentId: "main" },
        );
        expect(publicationWrite).toThrow("startup inspection");
        expect(isAgentDatabaseStartupReadReady(pathname, { env })).toBe(
          contents !== "missing-index",
        );
        expect(isAgentDatabaseStartupReadReady(`${pathname}.other`, { env })).toBe(false);
        const writeSettled = vi.fn();
        const writing = Promise.resolve(admission.waitForAgentPreparation("main", { env })).then(
          writeSettled,
          writeSettled,
        );
        if (contents !== "missing-index") {
          expect(admission.waitForAgentPreparation("main", { forWrite: false })).toBeUndefined();
          const read = withinTest(
            withEntry(scope.sessionKey, scope, (row) => row.entry),
            signal,
          );
          if (contents === "invalid-row") {
            await expect(read).rejects.toThrow("invalid persisted session row requires repair");
          } else {
            await expect(read).resolves.toEqual(entry);
          }
        }
        expect(writeSettled).not.toHaveBeenCalled();
        if (contents === "superseded") {
          current = false;
        }
        const stopping = contents === "stopped" ? owner.stop() : undefined;
        if (!current || stopping) {
          expect(readAgentDatabaseReadAdmissionRefusal("main", { env })).toBeDefined();
          expect(admission.waitForAgentPreparation("main", { forWrite: false })).toBeUndefined();
        }
        integrity.release();
        await admission.pendingPreparation;
        await stopping;
        await writing;
        expect(writeSettled).toHaveBeenCalledTimes(1);
        expect(isAgentDatabaseStartupReadReady(pathname, { env })).toBe(false);
        expect(Boolean(readAgentDatabaseReadAdmissionRefusal("main", { env }))).toBe(
          ["failed", "stopped", "superseded"].includes(contents),
        );
        expect(phases).toEqual(
          contents === "missing-index"
            ? ["open", "migration", "publication"]
            : ["stopped", "superseded"].includes(contents)
              ? ["publication", "open"]
              : ["publication", "open", "migration"],
        );
      } finally {
        integrity.release();
        await owner.stop();
      }
    });
  },
);

it.for(["before-promotion", "revoked", "aborted"] as const)(
  "keeps shared integrity preparation alive after its initiating caller is %s",
  async (cancellation, { signal }) => {
    const env = makeEnv("agent-stale-shared-");
    const options = { agentId: "main", env };
    const database = openAgent(options);
    const stale = claimOpenClawAgentDatabaseLease({ ...options, path: database.path });
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_start_time = -1 WHERE lease_id = ?")
      .run(stale);
    closeAgent(database.path);
    invalidateValidation(database.path);
    revokeSqliteDatabaseAdmissionsForPath(database.path);
    expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);

    counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const integrity = holdIntegrity(database.path);
    const initiator = capture(options);
    const borrowers = [initiator, ...Array.from({ length: 2 }, () => capture(options))];
    const source = sourceFor(() => {});
    const retainedRegistry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env }, () => false);
    const controller = new AbortController();
    let initiatingCallerCurrent = true;
    const refused = new Error("Initiating caller cancelled after integrity started");
    const initiatingSource = sourceFor(() => {
      controller.signal.throwIfAborted();
      if (!initiatingCallerCurrent) {
        throw refused;
      }
    });
    const initiatingOperation = vi.fn((scope: AgentDatabaseExecutionScope) =>
      initialized(scope, "initiator"),
    );
    const runOperation = sqliteWorkerStore.runSqliteWorkerStoreOperation;
    const promotion =
      cancellation === "before-promotion"
        ? vi
            .spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation")
            .mockImplementationOnce((...args) => {
              initiatingCallerCurrent = false;
              promotion?.mockRestore();
              return runOperation(...args);
            })
        : undefined;
    const initiating =
      cancellation === "aborted"
        ? initiator.prepare(initiatingSource, controller.signal)
        : initiator.runExisting(initiatingSource, initiatingOperation);
    void initiating.catch(() => {});
    let peers: Promise<unknown>[] = [];
    try {
      if (cancellation === "before-promotion") {
        await expect(initiating).rejects.toBe(refused);
        expect(initiatingCallerCurrent).toBe(false);
        expect(() => borrowers[1]!.assertCurrent()).not.toThrow();
      } else {
        await withinTest(integrity.entered(), signal);
      }
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
            ...sourceFor(() => registry.assertCurrent()),
            onRegistryChange: registry.followRegistration,
          },
          (scope) => initialized(scope, `peer-${index}`),
        );
      });
      void Promise.allSettled(peers);
    } finally {
      promotion?.mockRestore();
      integrity.release();
    }
    try {
      expect(await Promise.allSettled(peers)).toEqual(
        [0, 1].map((index) => ({
          status: "fulfilled",
          value: expect.objectContaining({
            kind: "session-transcript-initialized",
            sessionKey: `agent:main:peer-${index}`,
          }),
        })),
      );
      await expect(initiating).rejects.toBe(refused);
      expect(initiatingOperation).not.toHaveBeenCalled();
      await expect(initiator.runExisting(initiatingSource, initiatingOperation)).rejects.toBe(
        refused,
      );
      expect(checks()).toEqual([1, 1]);
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
    const reopened = nativeGeneration(database, workerContext({ env }), () => {});
    try {
      expect(await reopened.run(source, async () => "reopened")).toBe("reopened");
      expect(checks()).toEqual([1, 1]);
    } finally {
      await reopened.close();
    }
  },
);

it.for(["warm", "cold", "peer"] as const)(
  "serves shared ingress and prepares peers while agent integrity is held (%s)",
  { timeout: 30_000 },
  async (workload, { signal }) => {
    const env = makeEnv("agent-preparation-isolation-");
    const databases = ["slow", "ready", "next"].map((agentId) => openAgent({ agentId, env }));
    const integrity = holdIntegrity(databases[0]!.path);
    invalidateValidation(databases[0]!.path);
    const executions = databases.map((database) =>
      capture({ agentId: database.agentId, path: database.path, env }),
    );
    const source = sourceFor(() => {});
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "synthetic",
      stateDir: env.OPENCLAW_STATE_DIR,
    });
    const pending: Promise<void>[] = [];
    let slowPrepared = false;
    try {
      // Warm ingress and the ready agent occupy both ordinary slots before the slow open.
      if (workload === "warm") {
        await queue.enqueue("before", { text: "before preparation" });
      }
      if (workload !== "peer") {
        await executions[1]!.prepare(source);
      }
      const preparing = executions[0]!.prepare(source).then(() => {
        slowPrepared = true;
      });
      pending.push(preparing);
      void preparing.catch(() => {});
      await withinTest(integrity.entered(), signal);
      if (workload === "peer") {
        for (const execution of executions.slice(1)) {
          const preparingPeer = execution.prepare(source);
          pending.push(preparingPeer);
          await withinTest(preparingPeer, signal);
        }
      } else {
        await withinTest(queue.enqueue("during", { text: "during preparation" }), signal);
        expect((await queue.listPending()).map((event) => event.id)).toEqual(
          workload === "warm" ? ["before", "during"] : ["during"],
        );
      }
      expect(slowPrepared).toBe(false);
    } finally {
      integrity.release();
      await Promise.allSettled(pending);
      await Promise.all(executions.map((execution) => execution.release()));
    }
    expect(slowPrepared).toBe(true);
  },
);

it.each(["confirmed close", "native exit"] as const)(
  "uses native close evidence before recovering an agent lease (%s)",
  async (outcome) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-native-close-") };
    const database = openAgent({ agentId: "main", env });
    const shared = openOpenClawStateDatabase({ env });
    const leases = () =>
      shared.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
        .all(database.path);
    const hostLeases = leases();
    expect(hostLeases).toHaveLength(1);
    const generation = nativeGeneration(database, workerContext({ env }));
    const workers: Worker[] = [];
    const observeWorker = (worker: Worker) => workers.push(worker);
    const cleanup = vi.spyOn(stateWorkerStore, "openOpenClawStateWorkerCleanupStore");
    process.on("worker", observeWorker);
    try {
      await expect(generation.run(generation.source, async () => "opened")).resolves.toBe("opened");
      expect(leases()).toHaveLength(2);
      const validation = getValidation(database);
      assert(validation, "native generation must publish validation before retirement");
      process.off("worker", observeWorker);
      if (outcome === "native exit") {
        expect(workers.length).toBeGreaterThan(0);
        await Promise.all(workers.map((worker) => worker.terminate()));
        expect(leases()).toHaveLength(2);
        expect(cleanup).not.toHaveBeenCalled();
        expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(0);
        expect(getValidation(database)).toBeUndefined();
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

it.each(["cleanup", "protocol"] as const)(
  "retires every borrower when native opening fails (%s)",
  async (failure) => {
    const options = { agentId: "main", env: makeEnv("agent-open-failure-") };
    closeAgent(openAgent(options).path);
    const [rejected, retained] = [capture(options), capture(options)] as const;
    const refusal = new Error("Physical owner refused native agent open");
    const cleanupError = new Error("Physical owner cleanup failed after granting open");
    let nativeCurrent = true;
    let domainOpenRequests = 0;
    const source = sourceFor(() => {});
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const fault = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) => {
        if (!isRecord(attachment) || attachment.kind !== "agent-execution") {
          return createAdmission(admit, attachment);
        }
        if (failure === "protocol") {
          const admission = createAdmission(admit, attachment);
          admission.port.postMessage(
            { kind: "native-settlement", settlement: { kind: "invalid" } },
            [],
          );
          admission.service();
          return admission;
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
            // Factory entry is granted, but the native open must still admit its physical owner.
            nativeCurrent = false;
            throw cleanupError;
          }
        }, attachment);
      });
    const operation = vi.fn(async () => "not admitted");
    try {
      const opening = rejected.runExisting(source, operation);
      if (failure === "cleanup") {
        await expect(opening).rejects.toBeInstanceOf(AggregateError);
        await expect(opening).rejects.toMatchObject({
          cause: refusal,
          errors: [refusal, { errors: [cleanupError] }],
        });
        expect(domainOpenRequests).toBe(1);
      } else {
        await expect(opening).rejects.toThrow("SQLite worker native settlement is invalid");
      }
      nativeCurrent = true;
      expect(() => retained.assertCurrent()).toThrow(
        "Agent database execution admission is closed",
      );
      await expect(retained.runExisting(source, operation)).rejects.toThrow(
        "Agent database execution admission is closed",
      );
      expect(operation).not.toHaveBeenCalled();
    } finally {
      fault.mockRestore();
      nativeCurrent = true;
      await Promise.all([rejected.release(), retained.release()]);
      await closeOpenClawAgentDatabasesAsync();
    }
  },
);

it.each(["settled", "pending"] as const)(
  "prepares missing storage after an existing-only miss (%s)",
  async (timing) => {
    const env = makeEnv("agent-prepare-missing-");
    const execution = capture({ agentId: "main", env });
    const source = sourceFor(() => execution.assertCurrent());
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

it.each([
  ["verified", 0],
  ["two-leases", 0],
  ["two-leases-missing-metadata", 0],
  ["two-leases-stale", 1],
  ["two-leases-unknown-owner", 0],
  ["two-leases-unclean", 1],
  ["prepared-existing", 0],
  ["invalidated", 1],
  ["failed", 0],
  ["revoked-before-grant", 1],
  ["revoked-after-verification-admission", 1],
  ["missing-metadata", 1],
  ["closed-host", 0],
  ["closed-host-blocked", 0],
  ["closed-host-blocked-last", 0],
  ["closed-host-revoked", 1],
  ["closed-host-replaced", 1],
  ["closed-host-no-receipt", 1],
  ["closed-host-no-receipt-rollback", 1],
] as const)(
  "native execution borrows only current host integrity proof (%s)",
  async (proof, expectedChecks) => {
    const env = makeEnv("agent-native-integrity-");
    const database = openAgent({ agentId: "main", env });
    expect(getValidation(database)).toBeDefined();
    const verifiedAt = readSqliteDatabaseIntegrityVerification(database.path)?.verifiedAt;
    expect(verifiedAt).toBeDefined();
    counter.path = database.path;
    counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const context = workerContext({ env });
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
      closeAgent(database.path);
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
    const source = sourceFor(assertCurrent, (request) => {
      if (
        request.stage !== "prepare" ||
        typeof request.facts !== "object" ||
        request.facts === null ||
        !("kind" in request.facts)
      ) {
        return;
      }
      if (proof === "revoked-before-grant" && request.facts.kind === "shared-owner") {
        // Revoke the already-sent proof while the native opener still awaits its grant.
        invalidateValidation(database.path);
        revokedBeforeGrant = true;
      }
      if (
        proof === "revoked-after-verification-admission" &&
        request.facts.kind === "agent-validation-start"
      ) {
        invalidateValidation(database.path);
        revokedAfterVerificationAdmission = true;
      }
    });
    const generation = nativeGeneration(database, context, assertCurrent);
    if (
      proof === "invalidated" ||
      proof === "closed-host-revoked" ||
      proof === "revoked-after-verification-admission"
    ) {
      invalidateValidation(database.path);
    } else if (proof === "closed-host-replaced") {
      fs.copyFileSync(database.path, `${database.path}.replacement`);
      fs.renameSync(`${database.path}.replacement`, database.path);
    } else if (proof === "failed") {
      recordOpenClawAgentDatabaseOpenFailure(database.path, new Error("Synthetic host failure"));
    } else if (proof === "missing-metadata") {
      invalidateValidation(database.path);
      revokeSqliteDatabaseAdmissionsForPath(database.path);
    }
    const operation = vi.fn(async () => "opened");
    try {
      if (proof === "failed" || proof === "revoked-after-verification-admission") {
        await expect(generation.run(source, operation)).rejects.toThrow(
          proof === "failed"
            ? "OpenClaw agent database claim is no longer current"
            : "Agent schema admission changed before publication",
        );
        expect(operation).not.toHaveBeenCalled();
        expect(
          proof === "failed" ? getValidation(database) : revokedAfterVerificationAdmission,
        ).toBe(proof === "failed" ? undefined : true);
        return;
      }
      await expect(
        generation.run(source, operation, undefined, proof === "prepared-existing"),
      ).resolves.toBe("opened");
      expect(revokedBeforeGrant).toBe(proof === "revoked-before-grant");
    } finally {
      try {
        await generation.close();
        expect(checks()).toEqual([expectedChecks, expectedChecks]);
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
  },
);

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
      const context = workerContext({ env });
      const assertCurrent = () => {
        context.admission.assertCurrent();
        assertAgentDatabaseAdmitted(agentId, { env });
      };
      const source = sourceFor(assertCurrent);
      const generation = nativeGeneration(fixture, context, assertCurrent, () =>
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
        await expect(
          generation.run(source, (scope) => {
            expect(checks(), agentId).toEqual([1, 1]);
            return initialized(scope, "after-crash", agentId);
          }),
        ).resolves.toMatchObject({ kind: "session-transcript-initialized", sessionKey });
        expect(checks(), agentId).toEqual([1, 1]);
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
    env: makeEnv("agent-close-peers-"),
  });
  const source = sourceFor(() => {});
  const peers = [];
  const options = [];
  // Retained agents share broker workers with the next native opener.
  for (let index = 0; index < 4; index += 1) {
    const target = fixture();
    options.push(target);
    const peer = capture(target);
    await peer.prepare(source);
    peers.push(peer);
  }
  const target = fixture();
  options.push(target);
  const execution = capture(target);
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
