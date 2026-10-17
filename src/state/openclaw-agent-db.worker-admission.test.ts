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
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
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
import {
  openOpenClawAgentDatabaseReadOnly,
  hasOpenClawAgentReadOnlySchema,
} from "./openclaw-agent-db-readonly-open.js";
import * as validationCache from "./openclaw-agent-db-validation-cache.js";
import {
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { withOpenClawAgentDatabaseWrite } from "./openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import {
  readAgentDatabaseExecutionAuthority,
  AgentDatabaseExecutionLifetime,
} from "./openclaw-agent-execution-authority.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
  const facts = getAdmittedSqliteSchemaFacts(requireNativeSqliteDatabase(database));
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
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-creation-validation-") };
    const options = {
      agentId: "main",
      env,
      path: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
    };
    const creator = captureOpenClawAgentDatabaseExecution(options, {
      expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
    });
    const peer = openOpenClawAgentDatabase({ agentId: "peer", env });
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
    let validation: ReturnType<typeof getOpenClawAgentDatabaseValidationForTransfer>;
    const publish = () => {
      const database = openOpenClawAgentDatabase(options);
      validation = getOpenClawAgentDatabaseValidationForTransfer(database);
      assert(validation);
      expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
    };
    const source = (observeHandoff = false): AgentDatabaseRequestExecutionSource => ({
      assertCurrent() {},
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
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
            binding.authorize(request);
            if (!grant()) {
              throw new Error("Creation validation fixture lost admission");
            }
          }, binding.attachment),
        });
      },
    });
    try {
      await healthy.run(source(), async () => "healthy");
      const peerValidation = getOpenClawAgentDatabaseValidationForTransfer(peer);
      assert(peerValidation);
      if (phase === "before handoff") {
        publish();
      }
      await expect(creator.prepare(source(phase === "after handoff"))).rejects.toThrow(
        /changed before creating open/,
      );
      assert(validation);
      expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
      expect(getOpenClawAgentDatabaseValidationForTransfer(options)?.receiptId).toBe(
        validation.receiptId,
      );
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

it("adopts worker admission after a retained reader observes an already-revalidated schema", async () => {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-reader-readmission-") },
  };
  const database = await withOpenClawAgentDatabaseWrite(options, (opened) => opened);
  const reader = openOpenClawAgentDatabaseReadOnly(options);
  assert(reader.found);
  expect(validationCache.hasOpenClawAgentCanonicalValidation(reader.database)).toBe(true);
  const foreign = openNodeSqliteDatabase(database.path);
  foreign.exec("CREATE TABLE late_reader_fixture(value TEXT)");
  foreign.close();
  closeCachedOpenClawAgentDatabase(database);
  const capture = validationCache.captureOpenClawAgentDatabaseAdmissionPublication;
  const observeReader = vi.fn(() => {
    expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
  });
  const publication = vi
    .spyOn(validationCache, "captureOpenClawAgentDatabaseAdmissionPublication")
    .mockImplementation((target) => {
      const publish = capture(target);
      return (identity, received) => {
        publish(identity, received);
        // A retained read can run after worker publication, before the awaiting host adopts it.
        observeReader();
      };
    });
  try {
    await expect(
      withOpenClawAgentDatabaseWrite(options, ({ db }) => {
        expect(getAdmittedSqliteSchemaFacts(db)?.tables.has("late_reader_fixture")).toBe(true);
        return db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count;
      }),
    ).resolves.toBe(0);
    expect(observeReader).toHaveBeenCalled();
  } finally {
    publication.mockRestore();
    reader.database.close();
  }
});

it("keeps a worker recreation private until its host creation claim joins native close", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-creation-") };
  const options = { agentId: "recreated", env };
  const pathname = resolveOpenClawAgentSqlitePath(options);
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
  let opened: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
  await runWithAgentCreationClaim(options, async () => {
    const opening = withOpenClawAgentDatabaseWrite(options, (database) => {
      database.db.exec("INSERT INTO auth_profile_state VALUES ('created', '{}', 1)");
      return database;
    });
    await expect(
      outside(() => withOpenClawAgentDatabaseWrite(options, () => undefined)),
    ).rejects.toThrow(/active agent creation claim/);
    opened = await opening;
    expect(opened.db.isOpen).toBe(true);
    const alias = path.join(env.OPENCLAW_STATE_DIR, "alias.sqlite");
    fs.symlinkSync(pathname, alias);
    expect(() => outside(() => openOpenClawAgentDatabase({ ...options, path: alias }))).toThrow(
      /active agent creation claim/,
    );
  });
  expect(opened?.db.isOpen).toBe(false);
  expect(() => assertNoOpenClawAgentDatabaseLeases(options.agentId, { env })).not.toThrow();
  const reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    expect(
      reader.prepare("SELECT state_json FROM auth_profile_state WHERE state_key='created'").get(),
    ).toEqual({ state_json: "{}" });
  } finally {
    reader.close();
  }
});

it("admits cold storage in its worker and lends facts to every later native handle", async () => {
  const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-") } };
  openOpenClawStateDatabase({ env: options.env });
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const { inspections } = observeCallerSchemaInspections(pathname);
  const read = () =>
    withOpenClawAgentDatabaseWrite(options, (database) => {
      expectAdmittedSchemaObjects(database.db);
      return database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count;
    });
  expect(await Promise.all([read(), read()])).toEqual([0, 0]);
  expect(inspections).toEqual([]);
  const freshValidation = getOpenClawAgentDatabaseValidationForTransfer({
    agentId: options.agentId,
    path: pathname,
  });
  assert(freshValidation);
  expect(freshValidation.schema?.facts?.textEncoding).toBe("UTF-8");
  expect(Atomics.load(new Int32Array(freshValidation.canonicalReady), 0)).toBe(1);

  // Native handles share the worker's physical admission across orderly close.
  expectAdmittedSchemaObjects(openOpenClawAgentDatabase(options).db);
  expect(inspections).toEqual([]);
  await closeOpenClawAgentDatabaseByPathAsync(pathname);
  expectAdmittedSchemaObjects(openOpenClawAgentDatabase(options).db);
  expect(inspections).toEqual([]);
});

it("publishes freshly verified proof to a previously admitted alias after stale lease cleanup", async () => {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-alias-stale-proof-") },
  };
  const canonical = openOpenClawAgentDatabase(options);
  const aliasPath = path.join(options.env.OPENCLAW_STATE_DIR, "alias.sqlite");
  fs.symlinkSync(canonical.path, aliasPath);
  const alias = openOpenClawAgentDatabase({ ...options, path: aliasPath });
  closeCachedOpenClawAgentDatabase(alias);
  const staleLease = claimOpenClawAgentDatabaseLease({ ...options, path: canonical.path });
  openOpenClawStateDatabase({ env: options.env })
    .db.prepare("UPDATE agent_database_leases SET owner_start_time=-1 WHERE lease_id=?")
    .run(staleLease);
  canonical.db.exec("CREATE TABLE coldadmit_alias_fixture(value TEXT)");
  const observed = observeCallerSchemaInspections(canonical.path, aliasPath);
  try {
    await expect(
      withOpenClawAgentDatabaseWrite(
        { ...options, path: aliasPath },
        (database) =>
          database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count,
      ),
    ).resolves.toBe(0);
    await withOpenClawAgentDatabaseWrite({ ...options, path: aliasPath }, (database) => {
      expect(getAdmittedSqliteSchemaFacts(database.db)?.tables.has("coldadmit_alias_fixture")).toBe(
        true,
      );
    });
    expect(observed.inspections).toEqual([]);
  } finally {
    observed.restore();
    releaseOpenClawAgentDatabaseLease(staleLease, { env: options.env }, "read-only");
  }
});

it("recreates a closed database through its directory alias without revoking fresh publication", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-alias-recreation-")) };
  const canonicalPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  const alias = path.join(env.OPENCLAW_STATE_DIR, "alias");
  fs.symlinkSync(
    path.dirname(canonicalPath),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const options = { agentId: "main", env, path: path.join(alias, path.basename(canonicalPath)) };
  await withOpenClawAgentDatabaseWrite(options, ({ db }) => {
    db.exec("INSERT INTO auth_profile_state VALUES ('previous-file', '{}', 1)");
  });
  await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  fs.unlinkSync(canonicalPath);
  await expect(
    withOpenClawAgentDatabaseWrite(
      options,
      ({ db }) => db.prepare("SELECT COUNT(*) AS count FROM auth_profile_state").get()?.count,
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
  "foreign-missing-index",
  "idle-missing-index",
  "idle-revoked",
] as const)("readmits a host handle with its retained worker after %s", async (change) => {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-retained-readmission-") },
  };
  openOpenClawStateDatabase({ env: options.env });
  let retainedExecution = captureOpenClawAgentDatabaseExecution(options);
  try {
    const database = await withOpenClawAgentDatabaseWrite(options, (opened) => {
      opened.db.exec("INSERT INTO auth_profile_state VALUES ('retained', '{}', 1)");
      if (change.endsWith("additive-table")) {
        opened.db.exec("CREATE TABLE coldadmit_fixture(value TEXT)");
      } else if (change.endsWith("missing-index") && !change.startsWith("foreign-")) {
        opened.db.exec("DROP INDEX idx_agent_cache_expiry");
      } else if (change === "warm-rollback") {
        opened.db.exec("BEGIN; CREATE TABLE rolled_back_fixture(value TEXT); ROLLBACK;");
      }
      return opened;
    });
    let nativeClaim = retainedExecution.captureGenerationClaim();
    const revokedProof =
      change === "idle-revoked" ? getOpenClawAgentDatabaseValidation(database) : undefined;
    if (change.startsWith("idle-")) {
      const incarnation = nativeClaim.incarnation;
      await retainedExecution.release();
      await withOpenClawAgentDatabaseWrite({ ...options, agentId: "sibling" }, () => undefined);
      if (change === "idle-revoked") {
        expect(revokedProof).toBeDefined();
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
      }
      retainedExecution = captureOpenClawAgentDatabaseExecution(options);
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
    if (change === "foreign-missing-index") {
      const foreign = openNodeSqliteDatabase(database.path);
      try {
        foreign.exec("DROP INDEX idx_agent_cache_expiry");
      } finally {
        foreign.close();
      }
    }
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
      const count = await withOpenClawAgentDatabaseWrite(
        { ...options, path: acquisitionPath },
        (reopened) => {
          const facts = expectAdmittedSchemaObjects(reopened.db);
          expect(facts?.tables.has("coldadmit_fixture")).toBe(change.endsWith("additive-table"));
          expect(facts?.tables.has("session_key_contract")).toBe(true);
          expect(facts?.tables.has("rolled_back_fixture")).toBe(false);
          expect(facts?.indexes).toContain("idx_agent_cache_expiry");
          expect(
            reopened.db
              .prepare(
                "UPDATE auth_profile_state SET updated_at=updated_at+1 WHERE state_key='retained' RETURNING updated_at",
              )
              .get()?.updated_at,
          ).toBe(2);
          return reopened.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count;
        },
      );
      expect(count).toBe(0);
      if (revokedProof) {
        expect(Atomics.load(new Int32Array(revokedProof.valid), 0)).toBe(0);
        const readmitted = getOpenClawAgentDatabaseValidationForTransfer({
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
      if (change === "foreign-missing-index") {
        prepareRequests = 0;
        const repaired = await withOpenClawAgentDatabaseWrite(options, (opened) => opened);
        closeCachedOpenClawAgentDatabase(repaired);
        await expect(
          withOpenClawAgentDatabaseWrite(
            options,
            ({ db }) =>
              db
                .prepare("SELECT updated_at FROM auth_profile_state WHERE state_key='retained'")
                .get()?.updated_at,
          ),
        ).resolves.toBe(2);
        expect(prepareRequests).toBe(0);
      }
    } finally {
      unsubscribe();
      observed.restore();
    }
    if (change.endsWith("missing-index")) {
      const inspector = openNodeSqliteDatabase(database.path, { readOnly: true });
      try {
        expect(
          inspector
            .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
            .get()?.sql,
        ).toMatch(
          /^CREATE INDEX idx_agent_cache_expiry\s+ON cache_entries\(scope, expires_at, key\)\s+WHERE expires_at IS NOT NULL$/,
        );
      } finally {
        inspector.close();
      }
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
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-admit-drift-") },
    };
    let retainedExecution = retainWorker
      ? captureOpenClawAgentDatabaseExecution(options)
      : undefined;
    try {
      const database = await withOpenClawAgentDatabaseWrite(options, (opened) => opened);
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
        fs.copyFileSync(pathname, `${pathname}.replacement`);
        fs.renameSync(`${pathname}.replacement`, pathname);
      }
      if (change === "replacement") {
        fs.copyFileSync(pathname, `${pathname}.replacement`);
        fs.renameSync(`${pathname}.replacement`, pathname);
      }
      if (change === "damage") {
        revokeSqliteDatabaseAdmissionsForPath(pathname);
        fs.writeFileSync(pathname, "damaged SQLite fixture");
      } else if (change !== "warm-schema") {
        const editor = openNodeSqliteDatabase(pathname);
        try {
          const schemaBefore = metadataChange
            ? editor.prepare("PRAGMA schema_version").get()
            : undefined;
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
            expect(editor.prepare("PRAGMA schema_version").get()).toEqual(schemaBefore);
          }
        } finally {
          editor.close();
        }
      }
      if (metadataChange && retainWorker) {
        retainedExecution = captureOpenClawAgentDatabaseExecution(options);
      }
      const operation = vi.fn();
      const observed = retainWorker ? observeCallerSchemaInspections(pathname) : undefined;
      try {
        await expect(withOpenClawAgentDatabaseWrite(options, operation)).rejects.toThrow(
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

it.each(["once", "always", "source-revoked", "after-entry"] as const)(
  "recovers schema publication before execution without replaying admitted work: %s",
  async (failure) => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-schema-publication-") },
    };
    const database = openOpenClawAgentDatabase(options);
    const expectedIdentity = readDatabasePathIdentitySync(database.path);
    const execution = captureOpenClawAgentDatabaseExecution(options);
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Fixture request authority revoked");
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
            throw new Error("Fixture native admission expired");
          }
        }, binding.attachment),
      }),
    };
    let publications = 0;
    const capture = validationCache.captureOpenClawAgentDatabaseAdmissionPublication;
    vi.spyOn(
      validationCache,
      "captureOpenClawAgentDatabaseAdmissionPublication",
    ).mockImplementation((target) => {
      const publish = capture(target);
      return (identity, received) => {
        publications += 1;
        if (failure !== "after-entry" && (failure === "always" || publications === 1)) {
          // Revoke actual captured proof at the worker-to-host publication boundary.
          validationCache.invalidateOpenClawAgentDatabaseValidation(target.path);
          if (failure === "source-revoked") {
            current = false;
          }
        }
        publish(identity, received);
      };
    });
    const operation = vi.fn(async () => {
      if (failure === "after-entry") {
        throw new AgentDatabaseSchemaAdmissionChangedError();
      }
      return "executed";
    });
    try {
      const result = execution.runExisting(source, operation);
      if (failure === "once") {
        await expect(result).resolves.toBe("executed");
        expect(operation).toHaveBeenCalledTimes(1);
        expect(publications).toBe(2);
      } else {
        await expect(result).rejects.toThrow(
          failure === "source-revoked"
            ? "Fixture request authority revoked"
            : "Agent schema admission changed before publication",
        );
        expect(operation).toHaveBeenCalledTimes(failure === "after-entry" ? 1 : 0);
        expect(publications).toBe(failure === "always" ? 2 : 1);
      }
      expect(`file:${execution.fileIdentity?.physicalIdentity}`).toBe(expectedIdentity.key);
    } finally {
      await execution.release();
    }
  },
);

function executionAuthoritySource(
  observe: (
    request: SqliteWorkerAdmissionRequest,
    authority: SqliteWorkerExecutionAuthority,
  ) => void,
  beforeRelease?: (request: SqliteWorkerAdmissionRequest) => void,
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent() {},
    createAdmission(binding) {
      return () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          const authority = readSqliteWorkerExecutionAuthority(admission);
          if (authority) {
            observe(request, authority);
          }
          if (!grant(() => beforeRelease?.(request))) {
            throw new Error("Execution authority fixture lost admission");
          }
        }, binding.attachment);
        return { admission, nativeLocations: binding.nativeLocations };
      };
    },
  };
}

it("retains accepted work across borrower release and refuses late registration after retirement", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("execution-authority-")) };
  const options = {
    agentId: "main",
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const service = createSqliteWriterAdmissionService();
  const connection = await service.connect();
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  custody.accept();
  let authority: SqliteWorkerExecutionAuthority | undefined;
  const requestSource = executionAuthoritySource((_request, captured) => (authority = captured));
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

    const closing = closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
    expect(readAgentDatabaseExecutionAuthority(captured)).toBe(false);
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

    const replacement = captureOpenClawAgentDatabaseExecution(options);
    try {
      await replacement.prepare(requestSource);
      await replacement.runExisting(requestSource, (scope) =>
        scope.execute({
          type: "session.entry.read",
          input: { sessionKeys: ["agent:main:accepted"] },
        }),
      );
      expect(authority!.native.buffer).not.toBe(captured.native.buffer);
      expect(readAgentDatabaseExecutionAuthority(captured)).toBe(false);
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
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("execution-authority-")) };
  const options = {
    agentId: "main",
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  await execution.prepare(executionAuthoritySource(() => {}));
  let authority: SqliteWorkerExecutionAuthority | undefined;
  let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
  const requestSource = executionAuthoritySource(
    (_request, captured) => (authority = captured),
    (request) => {
      if (request.stage === "commit") {
        closing = closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
        expect(authority).toBeDefined();
        expect(readAgentDatabaseExecutionAuthority(authority!)).toBe(false);
      }
    },
  );
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
    const replacement = captureOpenClawAgentDatabaseExecution(options);
    try {
      await expect(
        replacement.runExisting(
          executionAuthoritySource(() => {}),
          (scope) =>
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
