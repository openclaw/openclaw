import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
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
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import { removeAgentIntegrityMetadataForTest } from "./openclaw-agent-db.test-support.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import * as verificationImplementation from "./openclaw-database-verify.impl.js";
import * as verification from "./openclaw-database-verify.js";
import {
  clearOpenClawAgentIntegrityVerification,
  readOpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import * as stateWorkerStore from "./openclaw-state-worker-store.js";

const counter = vi.hoisted(() => ({
  path: "",
  checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
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
const retainVerification = () => async () => {};

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
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent,
      createAdmission: (binding) => () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error("Native close fixture lost admission");
          }
        }, binding.attachment),
      }),
    };
    const generation = createAgentDatabaseNativeGeneration(
      database.agentId,
      database.path,
      context,
      assertCurrent,
      assertCurrent,
      undefined,
      () => {},
      retainVerification,
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
  const refusal = new Error("Original caller revoked before native agent open");
  const cleanupError = new Error("Original caller cleanup failed after granting open");
  let sourceCurrent = true;
  let domainOpenRequests = 0;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent() {
      if (!sourceCurrent) {
        throw refusal;
      }
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage === "open") {
            domainOpenRequests += 1;
          }
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Cleanup refusal fixture lost its admission");
          }
          if (request.stage === "open" && domainOpenRequests === 1) {
            // The broker granted factory entry; the factory must still admit its native open.
            sourceCurrent = false;
            throw cleanupError;
          }
        }, binding.attachment),
      });
    },
  };
  try {
    const opening = rejected.runExisting(source, async () => "not admitted");
    await expect(opening).rejects.toBeInstanceOf(AggregateError);
    await expect(opening).rejects.toMatchObject({
      cause: refusal,
      errors: [refusal, { errors: [cleanupError] }],
    });
    // The broker refuses the factory open before re-entering the domain callback.
    expect(domainOpenRequests).toBe(1);
    sourceCurrent = true;
    expect(() => retained.assertCurrent()).toThrow("Agent database execution admission is closed");
    await expect(retained.runExisting(source, async () => "not admitted")).rejects.toThrow(
      "Agent database execution admission is closed",
    );
  } finally {
    sourceCurrent = true;
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
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: () => {},
    createAdmission(binding) {
      return () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Protocol failure fixture lost admission");
          }
        }, binding.attachment);
        admission.port.postMessage(
          { kind: "native-settlement", settlement: { kind: "invalid" } },
          [],
        );
        admission.service();
        return { nativeLocations: binding.nativeLocations, admission };
      };
    },
  };
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
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: () => execution.assertCurrent(),
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            execution.assertCurrent();
            if (!grant()) {
              throw new Error("Missing database fixture lost admission");
            }
          }, binding.attachment),
        });
      },
    };
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
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assertCurrent();
        if (!grant()) {
          throw new Error("External store fixture lost its admission");
        }
      }, binding.attachment),
    }),
  };
  const generation = createAgentDatabaseNativeGeneration(
    "main",
    pathname,
    context,
    assertCurrent,
    assertCurrent,
    undefined,
    () => {},
    retainVerification,
  );
  const opening = await Promise.allSettled([generation.run(source, async () => "opened")]);
  const closing = await Promise.allSettled([generation.close()]);
  expect(opening).toEqual([{ status: "fulfilled", value: "opened" }]);
  expect(closing).toEqual([{ status: "fulfilled", value: undefined }]);
  expect(fs.readFileSync(pathname)).toEqual(bytes);
  expect(fs.readdirSync(external)).toEqual(["retained.sqlite"]);
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
  "version-mismatch",
  "closed-host",
  "closed-host-blocked",
  "closed-host-blocked-last",
  "closed-host-revoked",
  "closed-host-replaced",
] as const)("native execution borrows only current host integrity proof (%s)", async (proof) => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-native-integrity-")) };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
  counter.path = database.path;
  counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const context = captureOpenClawStateWorkerContext({ env });
  const closedHost = proof.startsWith("closed-host");
  const siblingLease =
    (closedHost && proof !== "closed-host-blocked-last") || proof.startsWith("two-leases")
      ? claimOpenClawAgentDatabaseLease({ agentId: database.agentId, path: database.path, env })
      : undefined;
  if (proof === "two-leases") {
    expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
  }
  if (proof === "two-leases-missing-metadata") {
    removeAgentIntegrityMetadataForTest(env);
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
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      expect(database.walMaintenance.health?.state).toBe("blocked");
      expect(database.db.isOpen).toBe(false);
      expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
    } finally {
      reader.close();
    }
  } else if (closedHost) {
    closeOpenClawAgentDatabaseByPath(database.path);
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
  const generation = createAgentDatabaseNativeGeneration(
    database.agentId,
    database.path,
    context,
    assertCurrent,
    assertCurrent,
    undefined,
    () => {},
    retainVerification,
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
    clearOpenClawAgentIntegrityVerification(database.path, env);
  } else if (proof === "version-mismatch") {
    const store = openNodeSqliteDatabase(resolveQuarantineStorePath(env));
    try {
      store.exec("UPDATE agent_integrity_verifications SET app_version='previous-release'");
    } finally {
      store.close();
    }
  }
  const integrityCheck = vi.spyOn(verification, "requestOpenClawAgentDatabaseIntegrityCheck");
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
    expect(integrityCheck).not.toHaveBeenCalled();
    expect(Array.from(new Int32Array(counter.checks))).toEqual(
      proof === "verified" ||
        proof === "prepared-existing" ||
        proof === "closed-host" ||
        proof === "closed-host-blocked" ||
        proof === "closed-host-blocked-last" ||
        proof === "two-leases" ||
        proof === "two-leases-missing-metadata" ||
        proof === "version-mismatch"
        ? [0, 0]
        : [1, 1],
    );
    expect(revokedBeforeGrant).toBe(proof === "revoked-before-grant");
  } finally {
    integrityCheck.mockRestore();
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
    expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(1);
  }
});

it.runIf(process.platform === "linux")(
  "classifies dead-owner admission using native WAL capabilities and provenance",
  async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-process-death-") };
    const cases = [
      "same-boot",
      "checkpointed-wal",
      "background-foreign-write",
      "background-revoked",
      "background-closed",
      "background-idle-swap",
      "background-idle-timeout",
      "background-replaced",
      "background-preparing",
      "background-preparation-failed",
      "foreign-boot",
      "legacy-lease",
      "pid-reused",
      "dirty-receipt",
      "corrupt-page",
      "interrupted-admission",
    ];
    const child = fork(
      fileURLToPath(new URL("./openclaw-agent-db-crash.test-support.ts", import.meta.url)),
      cases,
      { execArgv: ["--import", "tsx"], env: { ...process.env, ...env }, silent: true },
    );
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
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    expect(child.signalCode).toBe("SIGKILL");
    expect(fixtures.map((fixture) => fixture.agentId)).toEqual(cases);
    const shared = openOpenClawStateDatabase({ env });
    for (const fixture of fixtures) {
      const { agentId, path: pathname } = fixture;
      const deferred =
        agentId === "same-boot" ||
        agentId === "checkpointed-wal" ||
        agentId.startsWith("background-");
      const idle = agentId.startsWith("background-idle-");
      const pending = agentId.startsWith("background-prepar");
      const durable =
        agentId === "same-boot" ||
        agentId === "checkpointed-wal" ||
        agentId === "background-preparing" ||
        idle;
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
        expect(readOpenClawAgentIntegrityVerification(pathname, env)).toBeUndefined();
      } else {
        expect(readOpenClawAgentIntegrityVerification(pathname, env)?.clean_close).toBe(0);
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
      let current = true;
      const assertCurrent = () => {
        context.admission.assertCurrent();
        assertAgentDatabaseAdmitted(agentId, { env });
        if (!current) {
          throw new Error("Crash fixture admission revoked");
        }
      };
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent,
        createAdmission: (binding) => () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            assertCurrent();
            if (!grant()) {
              throw new Error("Crash fixture lost its current native admission");
            }
          }, binding.attachment),
        }),
      };
      const execution = idle
        ? captureOpenClawAgentDatabaseExecution({ agentId, path: pathname, env })
        : undefined;
      const generation = execution
        ? {
            run: execution.runExisting.bind(execution),
            close: () => closeOpenClawAgentDatabaseByPathAsync(pathname),
          }
        : createAgentDatabaseNativeGeneration(
            agentId,
            pathname,
            context,
            assertCurrent,
            () => context.admission.assertCurrent(),
            undefined,
            () => {},
            retainVerification,
          );
      const integrityCheck = vi.spyOn(verification, "requestOpenClawAgentDatabaseIntegrityCheck");
      try {
        if (agentId === "corrupt-page") {
          await expect(generation.run(source, async () => "opened")).rejects.toThrow(
            /integrity|malformed|corrupt/i,
          );
          expect(Atomics.load(new Int32Array(counter.checks), 0)).toBeGreaterThan(0);
          expect(integrityCheck).not.toHaveBeenCalled();
          continue;
        }
        const sessionKey = `agent:${agentId}:after-crash`;
        const initialize = async () => {
          await expect(
            generation.run(source, (scope) => {
              return scope.execute({
                type: "session.transcript.initialize",
                input: { sessionKey, sessionId: "after-crash" },
              });
            }),
          ).resolves.toMatchObject({ kind: "session-transcript-initialized", sessionKey });
        };
        const finishPreparation = createDeferredCore();
        let preparing: Promise<void> | undefined;
        if (pending) {
          const opened = createDeferredCore();
          const refusal = createAgentDatabaseInspectionRefusal({
            agentId,
            paths: [pathname],
            pending: true,
            reason: "Startup preparation is pending",
          });
          recordAgentDatabaseAdmissions([refusal], { env });
          preparing = preparePendingAgentDatabase(
            refusal,
            {
              env,
              assertCurrent: () => context.admission.assertCurrent(),
            },
            async () => {
              await initialize();
              opened.resolve();
              await finishPreparation.promise;
              if (agentId === "background-preparation-failed") {
                throw new Error("Synthetic startup preparation failed");
              }
            },
          ).catch((error: unknown) => {
            failPendingAgentDatabase(refusal, error, { env });
            opened.reject(error);
          });
          await opened.promise;
        } else {
          await initialize();
        }
        expect(Array.from(new Int32Array(counter.checks)), agentId).toEqual(
          deferred ? [0, 0] : [1, 1],
        );
        if (deferred) {
          expect(integrityCheck).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              path: pathname,
              env: expect.objectContaining(env),
              check: "full",
            }),
          );
          expect(readOpenClawAgentIntegrityVerification(pathname, env)).toBeUndefined();

          // Drop the foreground borrower while the check is still queued before startup.
          if (agentId === "background-idle-timeout") {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            try {
              await execution!.release();
              await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
            } finally {
              vi.useRealTimers();
            }
          } else {
            await execution?.release();
          }

          const applied = createDeferredCore();
          const applyResults = verificationImplementation.applyOpenClawDatabaseVerificationResults;
          let applicationError: unknown;
          const application = vi
            .spyOn(verificationImplementation, "applyOpenClawDatabaseVerificationResults")
            .mockImplementation(async (options) => {
              try {
                // The real child has finished its full scan; hold only the publication boundary.
                expect(options.results).toEqual([{ path: pathname, ok: true }]);
                if (agentId === "background-foreign-write") {
                  using foreign = openNodeSqliteDatabase(pathname);
                  foreign.exec(
                    "UPDATE auth_profile_state SET updated_at=2 WHERE state_key='committed-wal'",
                  );
                } else if (agentId === "background-revoked") {
                  current = false;
                } else if (agentId === "background-closed") {
                  await generation.close();
                } else if (agentId === "background-idle-swap") {
                  // Exceed the four warm slots while the scan's proof is still unpublished.
                  for (const siblingId of [
                    "same-boot",
                    "checkpointed-wal",
                    "background-foreign-write",
                    "background-revoked",
                    "background-closed",
                  ]) {
                    const sibling = captureOpenClawAgentDatabaseExecution({
                      agentId: siblingId,
                      env,
                    });
                    try {
                      await expect(sibling.runExisting(source, async () => "opened")).resolves.toBe(
                        "opened",
                      );
                    } finally {
                      await sibling.release();
                    }
                  }
                } else if (agentId === "background-replaced") {
                  const replacement = `${pathname}.replacement`;
                  using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
                  await requireNodeSqlite().backup(reader, replacement);
                  fs.renameSync(replacement, pathname);
                }
                let settled = false;
                const applying = applyResults(options).finally(() => {
                  settled = true;
                });
                if (pending) {
                  try {
                    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
                    await vi.advanceTimersByTimeAsync(0);
                    expect(settled, "verification must wait for startup admission").toBe(false);
                    expect(readOpenClawAgentIntegrityVerification(pathname, env)).toBeUndefined();
                  } finally {
                    vi.useRealTimers();
                    finishPreparation.resolve();
                    await preparing;
                  }
                }
                await applying;
              } catch (error) {
                applicationError = error;
                throw error;
              } finally {
                applied.resolve();
              }
            });
          let verifier: ReturnType<typeof verification.startOpenClawDatabaseIntegrityVerifier>;
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            verifier = verification.startOpenClawDatabaseIntegrityVerifier({ env });
            vi.advanceTimersByTime(0);
          } finally {
            vi.useRealTimers();
          }
          try {
            await applied.promise;
            await verifier.stop();
            expect(applicationError).toBeUndefined();
            expect(readOpenClawAgentIntegrityVerification(pathname, env), agentId).toEqual(
              durable
                ? expect.objectContaining({
                    verified_at: expect.any(Number),
                    clean_close: 0,
                  })
                : undefined,
            );
          } finally {
            await verifier.stop();
            application.mockRestore();
          }
        } else {
          expect(integrityCheck).not.toHaveBeenCalled();
        }
      } finally {
        integrityCheck.mockRestore();
        await execution?.release();
        await generation.close();
        if (idle) {
          // Worker preloads capture the next case's counter at creation.
          await closeOpenClawAgentDatabasesAsync();
        }
      }
      if (deferred) {
        expect(readOpenClawAgentIntegrityVerification(pathname, env)).toEqual(
          durable ? expect.objectContaining({ clean_close: 1 }) : undefined,
        );
        // Remove process-local proof so the successor can consume only the durable receipt.
        clearOpenClawAgentDatabaseValidationCache(pathname);
        counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
        current = true;
        recordAgentDatabaseAdmissions([], { env });
        const successor = createAgentDatabaseNativeGeneration(
          agentId,
          pathname,
          context,
          assertCurrent,
          assertCurrent,
          undefined,
          () => {},
          retainVerification,
        );
        try {
          await expect(successor.run(source, async () => "reopened")).resolves.toBe("reopened");
          expect(Array.from(new Int32Array(counter.checks)), agentId).toEqual(
            durable ? [0, 0] : [1, 1],
          );
        } finally {
          await successor.close();
          await verification.startOpenClawDatabaseIntegrityVerifier({ env }).stop();
        }
      }
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
