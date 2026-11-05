import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readSqliteBusyTimeout, setSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteWithYieldingAdmission } from "../../state/openclaw-agent-db-transaction.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { listSessionParticipantsReadOnly } from "./session-accessor.sqlite-participant-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import {
  readSessionEntryCurrentFacts,
  requestSessionEntryCurrentAdmission,
} from "./session-entry-current-admission.worker.js";
import type {
  SessionEntryCurrentFacts,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";

const tempDirs = createTempDirTracker();
const sessionKey = "agent:main:entry-revalidation";
const initialEntry = { label: "original", sessionId: "session-1", updatedAt: 10 };

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
});

let env: NodeJS.ProcessEnv;
let scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };
let database: ReturnType<typeof openOpenClawAgentDatabase>;

beforeEach(async () => {
  env = {
    ...process.env,
    OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-entry-revalidation-")),
  };
  scope = { agentId: "main", env, sessionKey };
  setRuntimeConfigSnapshot({});
  await upsertSessionEntryCore(scope, initialEntry);
  database = openOpenClawAgentDatabase({ agentId: "main", env });
});

const agent = (id: string) => ({ type: "agent" as const, id });
const assignOwner = (id: string, assignedAt: number) =>
  assignSessionOwner(scope, {
    owner: agent(id),
    assignedBy: { type: "human", id: "assigner" },
    assignedAt,
  });
const participant = (id: string, promptedAt: number) =>
  recordSessionParticipant(scope, { identity: agent(id), promptedAt });
const updateEntryJson = (db: DatabaseSync, expression: string, ...values: string[]) =>
  db
    .prepare(`UPDATE session_nodes SET entry_json = ${expression} WHERE session_key = ?`)
    .run(...values, sessionKey);
const storedEntry = () => loadExactSessionEntry(scope)?.entry;
const row = (projection = "*", db = requireNativeSqliteDatabase(database.db)) =>
  db.prepare(`SELECT ${projection} FROM session_nodes WHERE session_key = ?`).get(sessionKey);
const seedMain = () =>
  upsertSessionEntryCore(
    { ...scope, sessionKey: "agent:main:main" },
    { sessionId: "main-session", updatedAt: 10 },
  );
const invalidateLineage = () => {
  setCanonicalSqliteSessionMainKey(database, "work");
  setUnrelatedParent(requireNativeSqliteDatabase(database.db), "agent:main:unrecorded-parent");
};
function sourceFor(native: OpenClawAgentReadOnlyDatabase): SessionEntryCurrentSource {
  const identity = readOpenClawAgentDatabaseIdentity(native);
  assert(typeof identity.identity === "string", "Expected the fixture's durable database identity");
  return {
    agentId: native.agentId,
    path: native.path,
    databaseIdentity: identity.identity,
    databaseBirthtime: identity.birthtime,
    sessionKey,
  };
}

it.each(["native", "worker"] as const)(
  "publishes the %s patch's exact transcript predicate and rereads a sibling generation next time",
  async (route) => {
    const appended = appendTranscriptMessageSync(
      { ...scope, sessionId: "session-1" },
      { message: { role: "user", content: "receipt source" } },
    );
    assert(appended.ok && appended.value?.anchor, "Expected committed transcript anchor");
    const anchor = appended.value.anchor;
    const onCommitted = vi.fn();
    const options = {
      skipMaintenance: true,
      onCommitted,
      ...(route === "native" ? { assertCommitAllowed: () => {} } : {}),
      workerGuard: {
        shouldCommitIf: {
          kind: "transcript" as const,
          sessionId: "session-1",
          generation: anchor.generation,
          leafEntryId: anchor.entryId,
        },
      },
    };
    await expect(
      patchSessionEntryCore(scope, () => ({ label: "committed" }), options),
    ).resolves.toMatchObject({ label: "committed" });
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ label: "committed" }),
      {
        sessionId: "session-1",
        watermark: { generation: anchor.generation, maxSeq: anchor.rawSeq },
      },
    );
    {
      using sibling = openNodeSqliteDatabase(database.path);
      sibling
        .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
        .run("sibling-rewrite", "session-1");
    }
    await expect(
      patchSessionEntryCore(scope, () => ({ label: "must not commit" }), options),
    ).resolves.toBeNull();
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(storedEntry()?.label).toBe("committed");
    onCommitted.mockClear();
    await patchSessionEntryCore(scope, () => ({ sessionId: "rotated-session" }), {
      ...options,
      workerGuard: {
        shouldCommitIf: { ...options.workerGuard.shouldCommitIf, generation: "sibling-rewrite" },
      },
    });
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "rotated-session" }),
    );
  },
);

const targetFor = (canonicalKey = sessionKey) => ({
  agentId: scope.agentId,
  env: scope.env,
  storePath: database.path,
  target: { canonicalKey, storeKeys: [sessionKey] },
});

function patchEntry(
  route: "ordinary" | "lifecycle",
  update: Parameters<typeof patchSessionEntryCore>[1],
  replaceEntry = false,
) {
  const options = { replaceEntry, skipMaintenance: true };
  return route === "ordinary"
    ? patchSessionEntryCore(scope, update, options)
    : patchSessionEntryTarget(targetFor(), update, options);
}

function setUnrelatedParent(db: DatabaseSync, parentSessionKey: string | null): void {
  db.prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?").run(
    parentSessionKey,
    "agent:main:main",
  );
}

it("restores the connection's commit wait after admitting a rollback-journal write", async () => {
  await closeOpenClawAgentDatabasesAsync();
  database = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(database.db.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode).toBe("delete");
  setSqliteBusyTimeout(requireNativeSqliteDatabase(database.db), 37);
  using reader = new DatabaseSync(database.path);
  reader.exec("BEGIN");
  reader.prepare("SELECT session_key FROM session_nodes").get();
  const patched = await runOpenClawAgentWriteWithYieldingAdmission(
    (writer) => {
      expect(writer.db.isTransaction).toBe(true);
      expect(reader.isTransaction).toBe(true);
      expect(readSqliteBusyTimeout(requireNativeSqliteDatabase(writer.db))).toBe(37);
      reader.exec("ROLLBACK");
      return writeSessionEntry(writer, sessionKey, { ...initialEntry, label: "after reader" });
    },
    { agentId: "main", env },
  );
  expect(patched?.label).toBe("after reader");
  expect(row("json_extract(entry_json, '$.label') AS label", reader)).toEqual({
    label: "after reader",
  });
});

it.each(["none", "authority", "row", "connection"] as const)(
  "yields for the entry lock and revalidates changes (%s)",
  async (changed) => {
    using other = new DatabaseSync(database.path);
    const valid = changed === "none";
    // Bound the defective synchronous path without a timer or timing assertion.
    if (valid) {
      setSqliteBusyTimeout(requireNativeSqliteDatabase(database.db), 250);
    }
    let current = true;
    let updates = 0;
    let release: Promise<void> | undefined;
    const label = valid ? "after contention" : "must not commit";
    const assertCommitAllowed = () => {
      if (changed === "authority" && !current) {
        throw new Error("patch authority revoked");
      }
    };
    try {
      const patched = patchSessionEntryCore(
        scope,
        () => {
          updates += 1;
          other.exec("BEGIN IMMEDIATE");
          release = setImmediate().then(() => {
            if (changed === "row") {
              updateEntryJson(other, "json_set(entry_json, '$.label', 'foreign')");
            }
            other.exec(valid ? "ROLLBACK" : "COMMIT");
            current = false;
            if (changed === "connection") {
              closeOpenClawAgentDatabaseByPath(database.path);
            }
          });
          return { label };
        },
        {
          skipMaintenance: true,
          ...(valid ? { replaceEntry: false } : { assertCommitAllowed }),
        },
      );
      if (valid) {
        await expect(patched).resolves.toMatchObject({ label });
      } else {
        await expect(patched).rejects.toThrow(
          changed === "authority"
            ? "patch authority revoked"
            : changed === "row"
              ? /changed/
              : /closed|replaced|not open/,
        );
      }
      expect(updates).toBe(1);
      if (changed === "connection") {
        await closeOpenClawAgentDatabaseByPathAsync(database.path);
      }
      expect(storedEntry()?.label).toBe(valid ? label : changed === "row" ? "foreign" : "original");
    } finally {
      await release;
    }
  },
);

function currentFacts(native: OpenClawAgentReadOnlyDatabase) {
  const source = sourceFor(native);
  let entry: SessionEntryCurrentFacts | undefined;
  requestSessionEntryCurrentAdmission(
    source,
    { stage: "commit", facts: undefined },
    { database: native },
    (request) =>
      assertSessionEntryCurrentAdmission(request, {
        source,
        assertCurrent: (facts) => (entry = facts),
      }),
  );
  return entry;
}

it.each(["fresh", "sibling", "same-connection"] as const)(
  "refreshes owner facts after a %s write and discards rolled-back facts",
  (writer) => {
    // Fresh admission must first install its lazy revision tracker inside the transaction.
    using fresh = writer === "fresh" ? openNodeSqliteDatabase(database.path) : undefined;
    if (fresh) {
      registerOpenClawAgentDatabaseIdentity(fresh);
      admitSqliteSchema(fresh);
    }
    const native = fresh ? { agentId: database.agentId, path: database.path, db: fresh } : database;
    const connection = fresh ?? requireNativeSqliteDatabase(database.db);
    const original = {
      sessionId: "session-1",
      executionPolicy: {},
      lifecycleRevision: undefined,
      lifecycleRunId: undefined,
      activeWriterRunId: undefined,
    };
    if (!fresh) {
      expect(currentFacts(native)).toEqual(original);
    }
    const update = (db: DatabaseSync) =>
      updateEntryJson(
        db,
        "json_set(entry_json, '$.lifecycleRunId', ?, '$.lastRunId', ?)",
        "next-lifecycle",
        "hidden-successor",
      );
    if (writer === "sibling") {
      using other = openNodeSqliteDatabase(database.path);
      update(other);
    }
    const observe = () =>
      expect(currentFacts(native)).toMatchObject({
        lifecycleRunId: "next-lifecycle",
        lastRunId: "hidden-successor",
      });
    if (writer === "sibling") {
      observe();
      return;
    }
    const rollback = new Error("roll back compact read");
    const transaction = () => {
      connection.exec("BEGIN");
      try {
        update(connection);
        observe();
        throw rollback;
      } finally {
        connection.exec("ROLLBACK");
      }
    };
    expect(() =>
      fresh ? withSqlitePostCommitPublications(connection, transaction) : transaction(),
    ).toThrow(rollback);
    expect(currentFacts(native)).toEqual(original);
  },
);

it("preserves parser values and last duplicate owner fields through native admission", () => {
  currentFacts(database);
  {
    using other = openNodeSqliteDatabase(database.path);
    updateEntryJson(
      other,
      "substr(entry_json, 1, length(entry_json) - 1) || ?",
      ',"lifecycleRevision":42,"lifecycleRunId":"old","lifecycleRunId":null,"activeWriterRunId":false,"deviceFolder":{"deviceId":"paired-host","path":"/home/example/project"},"lastRunId":23}',
    );
  }
  const entry = currentFacts(database);
  const expected = {
    sessionId: "session-1",
    executionPolicy: {},
    lifecycleRevision: 42,
    deviceFolder: { deviceId: "paired-host", path: "/home/example/project" },
    lifecycleRunId: null,
    activeWriterRunId: false,
    lastRunId: 23,
  };
  expect(entry).toEqual(expected);
  const source = sourceFor(database);
  let observed: unknown;
  expect(
    assertSessionEntryCurrentAdmission(
      {
        stage: "commit",
        facts: { kind: "session-entry-current", source, entry, domainFacts: "write-1" },
      },
      { source, assertCurrent: (facts) => (observed = facts) },
    ),
  ).toEqual({ stage: "commit", facts: "write-1" });
  expect(observed).toEqual(expected);
});

it("refuses a captured source replaced by identical database bytes", async () => {
  const original = currentFacts(database);
  const source = sourceFor(database);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const bytes = fs.readFileSync(database.path);
  fs.renameSync(database.path, `${database.path}.original`);
  fs.writeFileSync(database.path, bytes, { mode: 0o600 });
  expect(fs.readFileSync(database.path)).toEqual(bytes);
  const request = {
    kind: "session-entry-current" as const,
    database: { agentId: "main", path: database.path },
    scope: { ...scope, databaseAgentId: "main", storePath: database.path },
  };
  expect(() => readSessionEntryCurrentFacts({ ...request, source })).toThrow();
  expect(readSessionEntryCurrentFacts(request).entry).toEqual(original);
});

it("commits an unchanged persisted row after evicting the host handle during preparation", async () => {
  const expected = { label: "renamed", sessionId: "session-1" };
  const persisted = await patchEntry("ordinary", () => {
    closeCachedOpenClawAgentDatabase(database);
    expect(database.db.isOpen).toBe(false);
    return { label: "renamed" };
  });
  expect(persisted).toMatchObject(expected);
  expect(storedEntry()).toMatchObject(expected);
});

it.each([
  ["ordinary", "patch"],
  ["lifecycle", "replace"],
  ["ordinary", "replace"],
  ["lifecycle", "evict"],
] as const)("revalidates unrelated lineage for %s %s", async (route, mode) => {
  await seedMain();
  const before = row();
  const allowed = route === "ordinary" && mode === "replace";
  const label = allowed ? "exact replacement" : "must not commit";
  const patched = patchEntry(
    route,
    (entry) => {
      invalidateLineage();
      expect(row()).toEqual(before);
      if (mode === "evict") {
        closeCachedOpenClawAgentDatabase(database);
        expect(database.db.isOpen).toBe(false);
        return null;
      }
      return { ...entry, label };
    },
    mode === "replace",
  );
  if (allowed) {
    await expect(patched).resolves.toMatchObject({ label });
  } else {
    await expect(patched).rejects.toThrow("openclaw doctor --fix");
  }
  // Invalid stores must be repaired without admission after host eviction.
  if (mode === "evict") {
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    using cleanup = new DatabaseSync(database.path);
    setUnrelatedParent(cleanup, null);
  } else {
    setUnrelatedParent(requireNativeSqliteDatabase(database.db), null);
  }
  expect(storedEntry()?.label).toBe(allowed ? label : "original");
});

it("rejects an intervening owner assignment even when entry JSON is unchanged", async () => {
  assignOwner("original-owner", 10);
  const before = row("entry_json");
  await expect(
    patchEntry("ordinary", () => {
      expect(assignOwner("new-owner", 20)).not.toBeNull();
      expect(row("entry_json")).toEqual(before);
      return { label: "must not commit" };
    }),
  ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
  expect(storedEntry()).toMatchObject({
    label: "original",
    owner: { actor: { type: "agent", id: "new-owner" }, assignedAt: 20 },
  });
});

it("preserves separately committed participants through patch and reopen with unchanged row projection", async () => {
  const participants = [
    ["existing", 10],
    ["new-participant", 20],
  ] as const;
  participant("existing", 10);
  const persisted = await patchEntry("ordinary", () => {
    const before = row();
    expect(participant("new-participant", 20)).toBe("inserted");
    expect(row()).toEqual(before);
    expect(storedEntry()?.label).toBe("original");
    return { label: "with participants" };
  });
  expect(persisted).toMatchObject({ sessionId: "session-1", label: "with participants" });
  expect(await closeOpenClawAgentDatabaseByPathAsync(database.path)).toBe(true);
  expect(storedEntry()).toMatchObject({
    label: "with participants",
    participantCount: 2,
    participants: expect.arrayContaining(
      participants.map(([id]) => expect.objectContaining({ identity: agent(id) })),
    ),
  });
  database = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toEqual(
    participants.map(([id, time]) => ({
      identity: agent(id),
      contributionCount: 1,
      firstPromptedAt: time,
      lastPromptedAt: time,
    })),
  );
  expect(
    row(
      "json_type(entry_json, '$.participants') AS participants, json_type(entry_json, '$.participantCount') AS participant_count",
    ),
  ).toEqual({ participants: null, participant_count: null });
});

it("rejects a lifecycle target selected under a different stored key", async () => {
  await expect(
    patchSessionEntryTarget(
      targetFor("agent:main:different-target"),
      () => ({ label: "must not move" }),
      { skipMaintenance: true },
    ),
  ).rejects.toThrow(
    "non-canonical persisted row resolves to session key agent:main:different-target",
  );
  expect(storedEntry()?.label).toBe("original");
  expect(
    loadExactSessionEntry({ ...scope, sessionKey: "agent:main:different-target" }),
  ).toBeUndefined();
});

it("preserves canonical creation policy when the writer receives an unrelated previous entry", async () => {
  const requiredScope = { ...scope, sessionKey: "agent:main:required-creation" };
  const stamp = {
    sandbox: "required" as const,
    createdVia: "operator" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: "creator" },
    createdAt: 10,
  };
  await upsertSessionEntryCore(requiredScope, {
    sessionId: "required-session",
    updatedAt: 10,
    ...stamp,
  });
  const previousEntry = storedEntry();
  expect(previousEntry?.sessionId).toBe("session-1");
  runOpenClawAgentWriteTransaction(
    (writeDatabase) =>
      writeSessionEntry(
        writeDatabase,
        requiredScope.sessionKey,
        {
          sessionId: "required-session",
          updatedAt: 20,
          label: "updated",
          createdVia: "plugin",
          createdAt: 20,
        },
        { previousEntry },
      ),
    { agentId: "main", env },
  );
  expect(loadExactSessionEntry(requiredScope)?.entry).toMatchObject({
    sessionId: "required-session",
    label: "updated",
    ...stamp,
  });
});
