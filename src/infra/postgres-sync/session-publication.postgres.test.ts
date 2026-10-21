import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { assertCompactionPathAlias } from "../../config/sessions/compaction-pathalias.test-support.js";
import { readPreparedSessionEntryChange } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryPublicationSource } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { captureDurableSessionActor } from "../../config/sessions/session-actor-durable.js";
import {
  assertSessionActorPathAliasReuse,
  createAliasedSessionStateRoot,
} from "../../config/sessions/session-actor-pathalias.test-support.js";
import {
  readSessionActorEntryFacts,
  readSessionActorRowFacts,
} from "../../config/sessions/session-actor-replica.js";
import {
  isSessionEntryPublicationAdmissionCurrent,
  isSessionEntryPublicationSourceCurrent,
} from "../../config/sessions/session-entry-publication-source.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { loadOwners } from "../../state/openclaw-agent-db.postgres.test-support.js";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../database-engine/context.test-support.js";
import { getPostgresPhysicalFactsForPath } from "../database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../database-engine/registry.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const harness = usePostgresTestHarness("publication");
const { connection, prefix, client, directories } = harness;
let root: string;
let rootPath: string;
let owners: Awaited<ReturnType<typeof loadOwners>>;
let database: ReturnType<typeof owners.openOpenClawAgentDatabase>;
if (connection) {
  owners = await loadOwners();
}
harness.onClose(async () => {
  if (database) {
    withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(database.path));
  }
  if (root) {
    await owners.cleanupSessionStateForTest({ stateDir: root, rootPath });
  }
});
harness.onReset(() => {
  resetDatabaseEngineSelectionForTest();
  vi.unstubAllEnvs();
});

function scopeFor(name: string) {
  return {
    agentId: "main",
    sessionKey: `agent:main:publication-${name}`,
    storePath: database.path,
  };
}

function targetFor(sessionKey: string) {
  const identity = readOpenClawAgentDatabaseIdentity(database);
  return {
    sessionKey,
    database: {
      kind: "file" as const,
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: identity.canonicalPath,
    },
  };
}

type PublishedEntry = NonNullable<ReturnType<typeof readPreparedSessionEntryChange>>;

function observeEntries(sessionKey: string) {
  const entries: PublishedEntry[] = [];
  const stop = sessionChanges.subscribeFacts((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      const entry = readPreparedSessionEntryChange(change, sessionKey);
      if (entry) {
        entries.push(entry);
      }
    }
  });
  return { entries, stop, [Symbol.dispose]: stop };
}

function withoutSql(body: () => void) {
  const statements: unknown[] = [];
  const sql = channel("openclaw.database.statement");
  const record = (value: unknown) => statements.push(value);
  sql.subscribe(record);
  try {
    body();
  } finally {
    sql.unsubscribe(record);
  }
  expect(statements).toEqual([]);
}

describe.skipIf(!connection)("PostgreSQL committed session publications", () => {
  beforeAll(async () => {
    rootPath = directories.make("pg-session-publication-");
    root = await createAliasedSessionStateRoot(rootPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    await client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
    database = withEngineStoreAdmission(() =>
      owners.openOpenClawAgentDatabase({ agentId: "main" }),
    );
  });
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", root));

  it.each([undefined, "different store", "changed writer"] as const)(
    "compacts through a symlinked state root (refusal=%s)",
    async (refusal) => {
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
      await captureRuntimeConfigAsyncReader()();
      const canonical = {
        ...scopeFor("compaction"),
        storePath: readOpenClawAgentDatabaseIdentity(database).canonicalPath,
        sessionId: `alias-compaction-${refusal ?? "success"}`,
        sessionKey: `agent:main:compaction-${refusal ?? "success"}`,
        env: { OPENCLAW_STATE_DIR: root },
      };
      await assertCompactionPathAlias(
        { ...canonical, storePath: database.path },
        canonical,
        refusal,
      );
    },
  );

  it("reuses the actor through admitted PG path aliases without crossing database identities", async () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    await captureRuntimeConfigAsyncReader()();
    const otherDatabase = withEngineStoreAdmission(() =>
      owners.openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(path.dirname(database.path), "other.sqlite"),
      }),
    );
    try {
      await assertSessionActorPathAliasReuse(database, otherDatabase);
    } finally {
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(otherDatabase.path));
    }
  });

  it("publishes complete replacements under PG admission and reuses fresh actor facts after patches", async () => {
    const scope = scopeFor("patch");
    const target = targetFor(scope.sessionKey);
    readSessionActorEntryFacts(target);
    const observed = observeEntries(scope.sessionKey);
    let actor: ReturnType<typeof captureDurableSessionActor> | undefined;
    try {
      await owners.upsertSessionEntryCore(scope, {
        sessionId: "publication-patch",
        updatedAt: 1,
        label: "before",
        skillsSnapshot: { prompt: "Synthetic persisted prompt", skills: [] },
      });
      expect(readSessionActorEntryFacts(target)?.entry).toMatchObject({
        label: "before",
        skillsSnapshot: { prompt: "Synthetic persisted prompt" },
      });
      await owners.appendTranscriptMessage(
        { ...scope, sessionId: "publication-patch" },
        { message: { role: "user", content: "Synthetic retained transcript" }, now: 2 },
      );
      const authority = { assertCurrent() {}, assertReadable() {}, authorize() {} };
      const currentActor = captureDurableSessionActor({
        database: { agentId: "main", path: database.path },
        target,
        lifetime: authority,
      });
      actor = currentActor;
      expect((await currentActor.read(authority)).entry?.label).toBe("before");
      observed.entries.length = 0;
      await owners.upsertSessionEntryCore(scope, { label: "after" });
      const published = observed.entries.findLast((entry) => entry.fullEntry?.label === "after");
      assert(published, "The committed replacement must publish its complete entry");
      const facts = getPostgresPhysicalFactsForPath(database.path);
      assert(facts);
      expect(published.source.admission).toEqual({
        engine: "postgres",
        namespace: facts.namespace,
        storeId: facts.storeId,
        admissionId: facts.admissionId,
      });
      expect(published.actorPostimage?.entry?.label).toBe("after");
      expect(published.actorPostimage?.writeToken).toBeTypeOf("string");
      expect(published.fullEntry?.skillsSnapshot?.prompt).toBe("Synthetic persisted prompt");

      withoutSql(() => {
        expect(isSessionEntryPublicationAdmissionCurrent(published.source)).toBe(true);
        expect(isSessionEntryPublicationSourceCurrent(published.source)).toBe(true);
        expect(readSessionActorEntryFacts(target)?.entry?.label).toBe("after");
        expect(
          readSessionActorRowFacts({ path: database.path, sessionKey: scope.sessionKey })?.entry
            .label,
        ).toBe("after");
        expect(currentActor.snapshot(authority)?.entry?.label).toBe("after");
      });

      await owners.upsertSessionEntryCore(scope, { label: "newer" });
      expect(isSessionEntryPublicationSourceCurrent(published.source)).toBe(false);
      expect(readSessionActorEntryFacts(target)?.entry).toMatchObject({
        label: "newer",
        skillsSnapshot: { prompt: "Synthetic persisted prompt" },
      });
    } finally {
      observed.stop();
      await actor?.release();
    }
  });

  it.each(["rollback", "unknown commit"] as const)(
    "does not publish candidate facts after %s",
    async (outcome) => {
      const scope = scopeFor(outcome.replaceAll(" ", "-"));
      const target = targetFor(scope.sessionKey);
      readSessionActorEntryFacts(target);
      await owners.upsertSessionEntryCore(scope, {
        sessionId: scope.sessionKey,
        updatedAt: 1,
        label: "before",
      });
      using observed = observeEntries(scope.sessionKey);
      const db = database.db;
      assert(isPostgresSqlConnection(db));
      const failure = new Error(`Synthetic ${outcome}`);
      const exec = db.exec.bind(db);
      using delivery =
        outcome === "unknown commit"
          ? vi.spyOn(db, "exec").mockImplementation((sql) => {
              exec(sql);
              if (sql === "COMMIT") {
                throw failure;
              }
            })
          : undefined;
      expect(() =>
        withEngineStoreAdmission(() =>
          owners.runOpenClawAgentWriteTransaction(
            (current) => {
              writeSessionEntry(current, scope.sessionKey, {
                sessionId: scope.sessionKey,
                updatedAt: 2,
                label: "candidate",
              });
              if (outcome === "rollback") {
                throw failure;
              }
            },
            { agentId: "main", path: database.path },
          ),
        ),
      ).toThrow(failure.message);
      expect(observed.entries).toEqual([]);
      expect(readSessionActorEntryFacts(target)?.entry?.label).not.toBe("candidate");
      delivery?.mockRestore();
      const facts = getPostgresPhysicalFactsForPath(database.path);
      assert(facts);
      const persisted = await client.query<{ entry_json: string }>(
        `SELECT entry_json FROM "${facts.namespace.replaceAll('"', '""')}".session_nodes WHERE session_key = $1`,
        [scope.sessionKey],
      );
      expect(JSON.parse(persisted.rows[0]!.entry_json)).toMatchObject({
        label: outcome === "rollback" ? "before" : "candidate",
      });
    },
  );

  it("rejects incomplete or mismatched PG admission without querying the database", async () => {
    const scope = scopeFor("identity");
    using observed = observeEntries(scope.sessionKey);
    await owners.upsertSessionEntryCore(scope, {
      sessionId: "publication-identity",
      updatedAt: 1,
      label: "committed",
    });
    const published = observed.entries.findLast((entry) => entry.fullEntry?.label === "committed");
    assert(published?.source.admission);
    const source = published.source;
    assert(source.admission);
    const admission = source.admission;
    const invalid: SessionEntryPublicationSource[] = [{ ...source, admission: undefined }];
    for (const field of ["namespace", "storeId", "admissionId"] as const) {
      invalid.push({
        ...source,
        admission: { ...admission, [field]: `different-${field}` },
      });
    }
    withoutSql(() => {
      expect(isSessionEntryPublicationSourceCurrent(source)).toBe(true);
      for (const candidate of invalid) {
        expect(isSessionEntryPublicationAdmissionCurrent(candidate)).toBe(false);
        expect(isSessionEntryPublicationSourceCurrent(candidate)).toBe(false);
      }
      expect(isSessionEntryPublicationSourceCurrent({ ...source, writeToken: undefined })).toBe(
        false,
      );
    });
  });
});
