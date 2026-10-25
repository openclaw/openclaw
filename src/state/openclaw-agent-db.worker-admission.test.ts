import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { getAdmittedSqliteSchemaFacts as schemaFacts } from "../infra/sqlite-schema-facts.js";
import type { SqliteWorkerExecutionAuthority } from "../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  readSqliteWorkerExecutionAuthority,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { SqliteWorkerSlotCustody } from "../infra/sqlite-worker-request-custody.js";
import {
  assertSqliteWriterBrokerAdmission,
  createSqliteWriterAdmissionService,
} from "../infra/sqlite-writer-admission-service.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { runWithAgentCreationClaim } from "./agent-creation-claim.js";
import { AgentDatabaseSchemaAdmissionChangedError } from "./agent-database-admission-error.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { closeCachedOpenClawAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import * as validationCache from "./openclaw-agent-db-validation-cache.js";
import {
  getOpenClawAgentDatabaseValidation as getValidation,
  getOpenClawAgentDatabaseValidationForTransfer as transferValidation,
  invalidateOpenClawAgentDatabaseValidation as invalidateValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { withOpenClawAgentDatabaseWrite as writeAgent } from "./openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeAgent,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase as openAgent,
  resolveOpenClawAgentSqlitePath as agentPath,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import {
  readAgentDatabaseExecutionAuthority as isAuthorityCurrent,
  AgentDatabaseExecutionLifetime,
} from "./openclaw-agent-execution-authority.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution as captureExecution } from "./openclaw-agent-execution.js";
import { expectRow, readRow } from "./openclaw-state-db-fixtures.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function makeOptions(prefix: string, agentId = "main") {
  return { agentId, env: { OPENCLAW_STATE_DIR: tempDirs.make(prefix) } };
}

function executionOptions(prefix: string) {
  const { agentId, env } = makeOptions(prefix);
  env.OPENCLAW_STATE_DIR = fs.realpathSync(env.OPENCLAW_STATE_DIR);
  return { agentId, env, path: agentPath({ agentId, env }) };
}

function replaceFile(pathname: string) {
  fs.copyFileSync(pathname, `${pathname}.replacement`);
  fs.renameSync(`${pathname}.replacement`, pathname);
}

function observePublications(observe: (path: string, publish: () => void) => void) {
  const capture = validationCache.captureOpenClawAgentDatabaseAdmissionPublication;
  return vi
    .spyOn(validationCache, "captureOpenClawAgentDatabaseAdmissionPublication")
    .mockImplementation((target) => {
      const publish = capture(target);
      return (identity, received) => observe(target.path, () => publish(identity, received));
    });
}

function countSessions({ db }: { db: EngineConnection }) {
  return readRow(db, "SELECT COUNT(*) AS count FROM session_nodes")?.count;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function observeCallerSchemaInspections(...pathnames: string[]) {
  const inspections: string[] = [];
  const observer = observeHostDataSql((sql, database) => {
    if (!database) {
      return;
    }
    const location = database.location();
    if (
      (location === null || pathnames.includes(location)) &&
      /sqlite_(?:schema|master)|PRAGMA\s+(?:index_|table_|quick_check|integrity_check|foreign_key_check)/i.test(
        sql,
      )
    ) {
      inspections.push(sql);
    }
  });
  return { inspections, restore: observer.restore };
}

function expectAdmittedSchemaObjects(database: EngineConnection) {
  const facts = schemaFacts(requireNativeSqliteDatabase(database));
  expect(facts?.textEncoding).toBe("UTF-8");
  expect(facts?.tables.has("session_nodes")).toBe(true);
  expect(facts?.indexes).toContain("idx_agent_session_nodes_updated_at");
  expect(facts?.triggers?.get("session_entry_snapshots_after_update")).toEqual({
    table: "session_entry_snapshots",
    sql: expect.stringContaining("UPDATE session_nodes SET snapshot_revision"),
  });
  return facts;
}

it.each(["before handoff", "after handoff"] as const)(
  "refuses stale creation %s without revoking admitted readers",
  async (phase) => {
    const { env } = makeOptions("agent-creation-validation-");
    const options = { agentId: "main", env, path: agentPath({ agentId: "main", env }) };
    const creator = captureExecution(options, {
      expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
    });
    const peer = openAgent({ agentId: "peer", env });
    const context = captureOpenClawStateWorkerContext({ env });
    const healthy = createAgentDatabaseNativeGeneration(
      peer.agentId,
      peer.path,
      context,
      new AgentDatabaseExecutionLifetime().state,
      () => context.admission.assertCurrent(),
      () => context.admission.assertCurrent(),
      undefined,
      () => {},
      () => {},
    );
    let validation: ReturnType<typeof transferValidation>;
    const publish = () => {
      const database = openAgent(options);
      validation = transferValidation(database);
      assert(validation);
      expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
    };
    const source = (observeHandoff = false) =>
      executionSource({
        beforeAuthorize(request) {
          if (
            observeHandoff &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "shared-owner" &&
            !validation
          ) {
            publish();
          }
        },
      });
    try {
      await healthy.run(source(), async () => "healthy");
      const peerValidation = transferValidation(peer);
      assert(peerValidation);
      if (phase === "before handoff") {
        publish();
      }
      await expect(creator.prepare(source(phase === "after handoff"))).rejects.toThrow(
        /changed before creating open/,
      );
      assert(validation);
      expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
      expect(transferValidation(options)?.receiptId).toBe(validation.receiptId);
      expect(Atomics.load(new Int32Array(peerValidation.valid), 0)).toBe(1);
      await expect(healthy.run(source(), async () => "healthy")).resolves.toBe("healthy");
    } finally {
      try {
        await creator.release();
      } finally {
        await healthy.close();
      }
    }
  },
);

it("keeps a worker recreation private until its host creation claim joins native close", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-creation-") };
  const options = { agentId: "recreated", env };
  const pathname = agentPath(options);
  const deletion = beginAgentDeletionJournal(
    {
      operationId: "recreation",
      deleteFiles: true,
      agentId: options.agentId,
      agentDir: path.dirname(pathname),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "workspace"),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "sessions"),
    },
    { env },
  );
  runOpenClawStateWriteTransaction(
    (database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    { env },
  );
  const outside = AsyncLocalStorage.snapshot();
  let opened: ReturnType<typeof openAgent> | undefined;
  await runWithAgentCreationClaim(options, async () => {
    const opening = writeAgent(options, (database) => {
      database.db.exec("INSERT INTO auth_profile_state VALUES ('created', '{}', 1)");
      return database;
    });
    await expect(outside(() => writeAgent(options, () => undefined))).rejects.toThrow(
      /active agent creation claim/,
    );
    opened = await opening;
    expect(opened.db.isOpen).toBe(true);
    const alias = path.join(env.OPENCLAW_STATE_DIR, "alias.sqlite");
    fs.symlinkSync(pathname, alias);
    expect(() => outside(() => openAgent({ ...options, path: alias }))).toThrow(
      /active agent creation claim/,
    );
  });
  expect(opened?.db.isOpen).toBe(false);
  expect(() => assertNoOpenClawAgentDatabaseLeases(options.agentId, { env })).not.toThrow();
  using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  expectRow(reader, "SELECT state_json FROM auth_profile_state WHERE state_key='created'", {
    state_json: "{}",
  });
});

it("admits cold storage in its worker and lends facts to every later native handle", async () => {
  const options = makeOptions("agent-admit-");
  openOpenClawStateDatabase({ env: options.env });
  const pathname = agentPath(options);
  const { inspections } = observeCallerSchemaInspections(pathname);
  const read = () =>
    writeAgent(options, (database) => {
      expectAdmittedSchemaObjects(database.db);
      return countSessions(database);
    });
  expect(await Promise.all([read(), read()])).toEqual([0, 0]);
  expect(inspections).toEqual([]);
  const freshValidation = transferValidation({
    agentId: options.agentId,
    path: pathname,
  });
  assert(freshValidation);
  expect(freshValidation.schema?.facts?.textEncoding).toBe("UTF-8");
  expect(Atomics.load(new Int32Array(freshValidation.canonicalReady), 0)).toBe(1);

  // Native handles share the worker's physical admission across orderly close.
  expectAdmittedSchemaObjects(openAgent(options).db);
  expect(inspections).toEqual([]);
  await closeAgent(pathname);
  expectAdmittedSchemaObjects(openAgent(options).db);
  expect(inspections).toEqual([]);
});

it("publishes freshly verified proof to a previously admitted alias after stale lease cleanup", async () => {
  const options = makeOptions("agent-alias-stale-proof-");
  const canonical = openAgent(options);
  const aliasPath = path.join(options.env.OPENCLAW_STATE_DIR, "alias.sqlite");
  fs.symlinkSync(canonical.path, aliasPath);
  const alias = openAgent({ ...options, path: aliasPath });
  closeCachedOpenClawAgentDatabase(alias);
  const staleLease = claimOpenClawAgentDatabaseLease({ ...options, path: canonical.path });
  openOpenClawStateDatabase({ env: options.env })
    .db.prepare("UPDATE agent_database_leases SET owner_start_time=-1 WHERE lease_id=?")
    .run(staleLease);
  canonical.db.exec("CREATE TABLE coldadmit_alias_fixture(value TEXT)");
  const observed = observeCallerSchemaInspections(canonical.path, aliasPath);
  try {
    await expect(writeAgent({ ...options, path: aliasPath }, countSessions)).resolves.toBe(0);
    await writeAgent({ ...options, path: aliasPath }, (database) => {
      expect(schemaFacts(database.db)?.tables.has("coldadmit_alias_fixture")).toBe(true);
    });
    expect(observed.inspections).toEqual([]);
  } finally {
    observed.restore();
    releaseOpenClawAgentDatabaseLease(staleLease, { env: options.env }, "read-only");
  }
});

it("recreates a closed database through its directory alias without revoking fresh publication", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-alias-recreation-")) };
  const canonicalPath = agentPath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  const alias = path.join(env.OPENCLAW_STATE_DIR, "alias");
  fs.symlinkSync(
    path.dirname(canonicalPath),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const options = { agentId: "main", env, path: path.join(alias, path.basename(canonicalPath)) };
  await writeAgent(options, ({ db }) => {
    db.exec("INSERT INTO auth_profile_state VALUES ('previous-file', '{}', 1)");
  });
  await closeAgent(options.path, options.agentId);
  fs.unlinkSync(canonicalPath);
  await expect(
    writeAgent(
      options,
      ({ db }) => readRow(db, "SELECT COUNT(*) AS count FROM auth_profile_state")?.count,
    ),
  ).resolves.toBe(0);
});

it.each([
  "eviction",
  "additive-table",
  "missing-index",
  "alias",
  "warm-additive-table",
  "warm-missing-index",
  "warm-rollback",
  "idle-missing-index",
  "idle-revoked",
] as const)("readmits a host handle with its retained worker after %s", async (change) => {
  const options = makeOptions("agent-retained-readmission-");
  openOpenClawStateDatabase({ env: options.env });
  let retainedExecution = captureExecution(options);
  try {
    const database = await writeAgent(options, (opened) => {
      opened.db.exec("INSERT INTO auth_profile_state VALUES ('retained', '{}', 1)");
      if (change.endsWith("additive-table")) {
        opened.db.exec("CREATE TABLE coldadmit_fixture(value TEXT)");
      } else if (change.endsWith("missing-index")) {
        opened.db.exec("DROP INDEX idx_agent_cache_expiry");
      } else if (change === "warm-rollback") {
        opened.db.exec("BEGIN; CREATE TABLE rolled_back_fixture(value TEXT); ROLLBACK;");
      }
      return opened;
    });
    let nativeClaim = retainedExecution.captureGenerationClaim();
    const revokedProof = change === "idle-revoked" ? getValidation(database) : undefined;
    if (change.startsWith("idle-")) {
      const incarnation = nativeClaim.incarnation;
      await retainedExecution.release();
      await writeAgent({ ...options, agentId: "sibling" }, () => undefined);
      if (change === "idle-revoked") {
        expect(revokedProof).toBeDefined();
        invalidateValidation(database.path);
        expect(getValidation(database)).toBeUndefined();
      }
      retainedExecution = captureExecution(options);
      nativeClaim = retainedExecution.captureGenerationClaim();
      expect(nativeClaim.incarnation).toBe(incarnation);
    }
    const acquisitionPath =
      change === "alias"
        ? path.join(options.env.OPENCLAW_STATE_DIR, "alias.sqlite")
        : database.path;
    if (change === "alias") {
      fs.symlinkSync(database.path, acquisitionPath);
    }
    if (!change.startsWith("warm-")) {
      closeCachedOpenClawAgentDatabase(database);
    }
    expect(database.db.isOpen).toBe(change.startsWith("warm-"));
    nativeClaim.assertCurrent();
    const observed = observeCallerSchemaInspections(database.path, acquisitionPath);
    let prepareRequests = 0;
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "worker.request" &&
          event.requestClass === "database.prepareWrite" &&
          event.phase === "queued"
        ) {
          prepareRequests++;
        }
      },
      { include: ["worker.request"] },
    );
    try {
      const count = await writeAgent({ ...options, path: acquisitionPath }, (reopened) => {
        const facts = expectAdmittedSchemaObjects(reopened.db);
        expect(facts?.tables.has("coldadmit_fixture")).toBe(change.endsWith("additive-table"));
        expect(facts?.tables.has("session_key_contract")).toBe(true);
        expect(facts?.tables.has("rolled_back_fixture")).toBe(false);
        expect(facts?.indexes).toContain("idx_agent_cache_expiry");
        expectRow(
          reopened.db,
          "UPDATE auth_profile_state SET updated_at=updated_at+1 WHERE state_key='retained' RETURNING updated_at",
          { updated_at: 2 },
        );
        return countSessions(reopened);
      });
      expect(count).toBe(0);
      if (revokedProof) {
        expect(Atomics.load(new Int32Array(revokedProof.valid), 0)).toBe(0);
        const readmitted = transferValidation({
          agentId: options.agentId,
          path: database.path,
        });
        expect(readmitted).toBeDefined();
        expect(Atomics.load(new Int32Array(readmitted!.valid), 0)).toBe(1);
        expect(readmitted!.valid).not.toBe(revokedProof.valid);
      }
      nativeClaim.assertCurrent();
      expect(observed.inspections).toEqual([]);
      if (change === "eviction") {
        expect(prepareRequests).toBe(0);
      }
    } finally {
      unsubscribe();
      observed.restore();
    }
    if (change.endsWith("missing-index")) {
      using inspector = openNodeSqliteDatabase(database.path, { readOnly: true });
      expect(
        readRow(inspector, "SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
          ?.sql,
      ).toMatch(
        /^CREATE INDEX idx_agent_cache_expiry\s+ON cache_entries\(scope, expires_at, key\)\s+WHERE expires_at IS NOT NULL$/,
      );
    }
  } finally {
    await retainedExecution.release();
  }
});

it.each([
  { change: "schema", retainWorker: false },
  { change: "owner", retainWorker: false },
  { change: "replacement", retainWorker: false },
  { change: "damage", retainWorker: false },
  { change: "schema", retainWorker: true },
  { change: "owner", retainWorker: true },
  { change: "metadata-version", retainWorker: true },
  { change: "metadata-missing", retainWorker: true },
  { change: "warm-schema", retainWorker: true },
] as const)(
  "refuses $change drift at worker admission with retained worker=$retainWorker",
  async ({ change, retainWorker }) => {
    const options = makeOptions("agent-admit-drift-");
    let retainedExecution = retainWorker ? captureExecution(options) : undefined;
    try {
      const database = await writeAgent(options, (opened) => opened);
      const pathname = database.path;
      if (change === "warm-schema") {
        database.db.exec(
          "ALTER TABLE auth_profile_state RENAME COLUMN state_json TO drifted_state_json",
        );
      } else if (retainedExecution) {
        closeCachedOpenClawAgentDatabase(database);
      } else {
        await closeOpenClawAgentDatabasesAsync();
      }
      const metadataChange = change === "owner" || change.startsWith("metadata-");
      if (metadataChange) {
        await retainedExecution?.release();
        retainedExecution = undefined;
        await closeOpenClawAgentDatabasesAsync();
        // Immutable ownership is checked on the replacement's first admission.
        replaceFile(pathname);
      }
      if (change === "replacement") {
        replaceFile(pathname);
      }
      if (change === "damage") {
        revokeSqliteDatabaseAdmissionsForPath(pathname);
        fs.writeFileSync(pathname, "damaged SQLite fixture");
      } else if (change !== "warm-schema") {
        using editor = openNodeSqliteDatabase(pathname);
        const schemaBefore = metadataChange ? readRow(editor, "PRAGMA schema_version") : undefined;
        editor.exec(
          change === "owner"
            ? "UPDATE schema_meta SET agent_id='another' WHERE meta_key='primary'"
            : change === "metadata-version"
              ? "UPDATE schema_meta SET schema_version=schema_version-1 WHERE meta_key='primary'"
              : change === "metadata-missing"
                ? "DELETE FROM schema_meta WHERE meta_key='primary'"
                : "ALTER TABLE auth_profile_state RENAME COLUMN state_json TO drifted_state_json",
        );
        if (metadataChange) {
          expectRow(editor, "PRAGMA schema_version", schemaBefore);
        }
      }
      if (metadataChange && retainWorker) {
        retainedExecution = captureExecution(options);
      }
      const operation = vi.fn();
      const observed = retainWorker ? observeCallerSchemaInspections(pathname) : undefined;
      try {
        await expect(writeAgent(options, operation)).rejects.toThrow(
          change === "owner" ? /belongs to agent another/ : /schema|malformed|not a database/i,
        );
        expect(operation).not.toHaveBeenCalled();
        if (observed) {
          expect(observed.inspections).toEqual([]);
        }
      } finally {
        observed?.restore();
      }
    } finally {
      await retainedExecution?.release();
    }
  },
);

it.each(["before-entry", "source-revoked", "after-entry"] as const)(
  "reports schema publication refusal without replaying work: %s",
  async (failure) => {
    const options = makeOptions("agent-schema-publication-");
    const database = openAgent(options);
    const expectedIdentity = readDatabasePathIdentitySync(database.path);
    const execution = captureExecution(options);
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Fixture request authority revoked");
      }
    };
    const source = executionSource({ assertCurrent });
    let publications = 0;
    observePublications((pathname, publish) => {
      publications += 1;
      if (failure !== "after-entry") {
        // Revoke actual captured proof at the worker-to-host publication boundary.
        invalidateValidation(pathname);
        if (failure === "source-revoked") {
          current = false;
        }
      }
      publish();
    });
    const operation = vi.fn(async () => {
      if (failure === "after-entry") {
        throw new AgentDatabaseSchemaAdmissionChangedError();
      }
      return "executed";
    });
    try {
      const result = execution.runExisting(source, operation);
      await expect(result).rejects.toThrow("Agent schema admission changed before publication");
      expect(operation).toHaveBeenCalledTimes(failure === "after-entry" ? 1 : 0);
      expect(publications).toBe(1);
      expect(`file:${execution.fileIdentity?.physicalIdentity}`).toBe(expectedIdentity.key);
    } finally {
      await execution.release();
    }
  },
);

function executionSource({
  observe,
  beforeRelease,
  beforeAuthorize,
  assertCurrent = () => {},
}: {
  observe?: (
    request: SqliteWorkerAdmissionRequest,
    authority: SqliteWorkerExecutionAuthority,
  ) => void;
  beforeRelease?: (request: SqliteWorkerAdmissionRequest) => void;
  beforeAuthorize?: (request: SqliteWorkerAdmissionRequest) => void;
  assertCurrent?: () => void;
} = {}): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission(binding) {
      return () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          beforeAuthorize?.(request);
          binding.authorize(request);
          assertCurrent();
          if (observe) {
            const authority = readSqliteWorkerExecutionAuthority(admission);
            if (authority) {
              observe(request, authority);
            }
          }
          const granted = beforeRelease ? grant(() => beforeRelease(request)) : grant();
          if (!granted) {
            throw new Error("Execution authority fixture lost admission");
          }
        }, binding.attachment);
        return { admission, nativeLocations: binding.nativeLocations };
      };
    },
  };
}

it("retains accepted work across borrower release and refuses late registration after retirement", async () => {
  const options = executionOptions("execution-authority-");
  const execution = captureExecution(options);
  const service = createSqliteWriterAdmissionService();
  const connection = await service.connect();
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  custody.accept();
  let authority: SqliteWorkerExecutionAuthority | undefined;
  const requestSource = executionSource({
    observe: (_request, captured) => (authority = captured),
  });
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  let release: Promise<void> | undefined;
  try {
    await execution.prepare(requestSource);
    const work = execution.runExisting(requestSource, async (scope) => {
      entered.resolve();
      await resume.promise;
      return scope.execute({
        type: "session.transcript.initialize",
        input: { sessionKey: "agent:main:accepted", sessionId: "accepted" },
      });
    });
    await entered.promise;
    release = execution.release();
    expect(() => execution.assertCurrent()).toThrow(/released/);
    resume.resolve();
    await expect(work).resolves.toMatchObject({ kind: "session-transcript-initialized" });
    await release;
    expect(authority).toBeDefined();
    const captured = authority!;
    assertSqliteWriterBrokerAdmission(connection, custody.descriptor, captured);

    const closing = closeAgent(options.path, options.agentId);
    expect(isAuthorityCurrent(captured)).toBe(false);
    await closing;

    // Delivery after retirement must read the original cells, even on a fresh service.
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    connection.port.postMessage(
      {
        custody: custody.descriptor,
        executionAuthority: structuredClone(captured),
        decision,
      },
      [],
    );
    await Atomics.waitAsync(decision, 0, 0).value;
    expect(Atomics.load(decision, 0)).toBe(2);

    const replacement = captureExecution(options);
    try {
      await replacement.prepare(requestSource);
      await replacement.runExisting(requestSource, (scope) =>
        scope.execute({
          type: "session.entry.read",
          input: { sessionKeys: ["agent:main:accepted"] },
        }),
      );
      expect(authority!.native.buffer).not.toBe(captured.native.buffer);
      expect(isAuthorityCurrent(captured)).toBe(false);
      assertSqliteWriterBrokerAdmission(connection, custody.descriptor, authority);
    } finally {
      await replacement.release();
    }
  } finally {
    resume.resolve();
    await release;
    await execution.release();
    connection.port.close();
    await service.close();
  }
});

it("publishes owner revocation before a host grant and rolls back the native write", async () => {
  const options = executionOptions("execution-authority-");
  const execution = captureExecution(options);
  await execution.prepare(executionSource());
  let authority: SqliteWorkerExecutionAuthority | undefined;
  let closing: ReturnType<typeof closeAgent> | undefined;
  const requestSource = executionSource({
    observe: (_request, captured) => (authority = captured),
    beforeRelease(request) {
      if (request.stage === "commit") {
        closing = closeAgent(options.path, options.agentId);
        expect(authority).toBeDefined();
        expect(isAuthorityCurrent(authority!)).toBe(false);
      }
    },
  });
  try {
    await expect(
      execution.runExisting(requestSource, (scope) =>
        scope.execute({
          type: "session.transcript.initialize",
          input: { sessionKey: "agent:main:revoked", sessionId: "revoked" },
        }),
      ),
    ).rejects.toThrow(/execution authority is revoked/);
    expect(closing).toBeDefined();
    await closing;
    const replacement = captureExecution(options);
    try {
      await expect(
        replacement.runExisting(executionSource(), (scope) =>
          scope.execute({
            type: "session.entry.read",
            input: { sessionKeys: ["agent:main:revoked"] },
          }),
        ),
      ).resolves.toMatchObject({ entries: [] });
    } finally {
      await replacement.release();
    }
  } finally {
    await closing;
    await execution.release();
  }
});
