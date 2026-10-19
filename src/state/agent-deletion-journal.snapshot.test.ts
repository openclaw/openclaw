import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  beginAgentDeletionJournal as beginJournal,
  removeAgentDeletionJournal as removeJournal,
} from "../test-utils/agent-deletion-journal.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState as withState } from "../test-utils/openclaw-test-state.js";
import { createRetainedAgentDatabaseMatcherFromSnapshot as retainedMatcher } from "./agent-deletion-discovery.js";
import { reconstructAgentDeletionJournal } from "./agent-deletion-journal-recovery.js";
import {
  completeAgentDeletionJournalInDatabase as completeJournal,
  updateAgentDeletionJournalPathsInDatabase as updateJournalPaths,
} from "./agent-deletion-journal.js";
import { prepareAgentDatabaseDeletionSnapshotRead as prepareSnapshot } from "./agent-deletion-journal.read.js";
import { readAgentDatabaseDeletionWorkerSnapshot } from "./agent-deletion-journal.snapshot.worker.js";
import { journalInput, withoutHostSql } from "./agent-deletion-journal.test-support.js";
import {
  registerOpenClawAgentDatabase as registerDatabase,
  unregisterOpenClawAgentDatabase as unregisterDatabase,
} from "./openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase as openAgentDb } from "./openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseByPathAsync as closeStateDb,
  openOpenClawStateDatabase as openStateDb,
  runOpenClawStateWriteTransaction as writeState,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as stateSqlitePath } from "./openclaw-state-db.paths.js";

it.each(["runtime", "runtime-discovery", "maintenance", "legacy"] as const)(
  "reads journal facts once per %s snapshot, including committed cleanup",
  async (scenario) => {
    const purpose = scenario === "legacy" ? "maintenance" : scenario;
    await withState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const database = openStateDb(options);
      beginJournal(journalInput(state, "retained"), options);
      beginJournal({ ...journalInput(state, "removed"), deleteFiles: true }, options);
      writeState((writer) => {
        completeJournal(writer, "removed", "delete-removed");
        writer.db
          .prepare("UPDATE agent_deletion_journal SET database_paths_json = ? WHERE agent_id = ?")
          .run(JSON.stringify(["x".repeat(64 * 1024)]), "removed");
        if (scenario === "legacy") {
          writer.db.exec("ALTER TABLE agent_deletion_journal DROP COLUMN phase");
        }
      }, options);
      const journalSelects: string[] = [];
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["journal"],
        (sql) => {
          if (!/^select\b.*from "agent_deletion_journal"/iu.test(sql)) {
            return null;
          }
          journalSelects.push(sql);
          return "journal";
        },
      );
      try {
        const before = readAgentDatabaseDeletionWorkerSnapshot(database.db, database.path, purpose);
        expect(
          Object.fromEntries(before.deletedAgents.map(({ agentId, status }) => [agentId, status])),
        ).toEqual({
          removed: "complete",
          retained: "pending",
        });
        expect(before.retainedDeletions).toMatchObject(
          purpose === "runtime" ? { status: "empty" } : { entries: [{ agentId: "retained" }] },
        );
        expect(reads.textBytes.journal).toBeLessThan(4096);
        expect(reads.counts.journal).toBe(1);
        if (scenario === "legacy") {
          // A bare bind in the SELECT list has no inferable parameter type on PostgreSQL.
          expect(journalSelects[0]).toContain('null as "phase"');
        }
        writeState((writer) => completeJournal(writer, "retained", "delete-retained"), options);
        const readsBeforeSnapshot = reads.counts.journal;
        const after = readAgentDatabaseDeletionWorkerSnapshot(database.db, database.path, purpose);
        expect(
          Object.fromEntries(after.deletedAgents.map(({ agentId, status }) => [agentId, status])),
        ).toEqual({
          removed: "complete",
          retained: "complete",
        });
        expect(after.retainedDeletions).toMatchObject({
          entries: [{ agentId: "retained", cleanupCompleted: true }],
        });
        expect(reads.counts.journal - readsBeforeSnapshot).toBe(1);
      } finally {
        reads.restore();
      }
    });
  },
);

it("reads fresh deletion and surviving-owner facts from its captured source without host SQL", async () => {
  await withState({ scenario: "minimal" }, async (state) => {
    const survivor = openAgentDb({ agentId: "survivor", env: state.env });
    const agentDir = state.agentDir("retired");
    const options = { env: state.env };
    beginJournal(journalInput(state, "retired", "retained-owner"), options);
    expect((await prepareSnapshot(options).read()).snapshot?.retainedDeletions).toMatchObject({
      status: "present",
      entries: [{ agentId: "retired" }],
    });
    expect((await prepareSnapshot(options, "runtime").read()).snapshot?.retainedDeletions).toEqual({
      status: "empty",
    });
    writeState((database) => {
      database.db
        .prepare("UPDATE agent_deletion_journal SET database_paths_json = '[1]' WHERE agent_id = ?")
        .run("retired");
    }, options);
    expect(
      (await prepareSnapshot(options, "runtime-discovery").read()).snapshot?.retainedDeletions,
    ).toMatchObject({ status: "present", entries: [{ agentId: "retired" }], held: [] });
    expect((await prepareSnapshot(options).read()).snapshot).toMatchObject({
      retainedDeletions: {
        status: "unavailable",
        cause: "unreadable",
        known: { entries: [{ agentId: "retired" }] },
      },
      deletedAgents: [{ agentId: "retired", status: "pending" }],
    });
    writeState((database) => {
      expect(
        updateJournalPaths(database, "retired", "retained-owner", "database_paths_json", [
          survivor.path,
        ]),
      ).toBe(true);
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["journal"],
        (sql) => (/^select\b.*from "agent_deletion_journal"/iu.test(sql) ? "journal" : null),
      );
      try {
        expect(completeJournal(database, "retired", "retained-owner")).toBe(true);
        expect(reads.counts.journal).toBe(0);
      } finally {
        reads.restore();
      }
    }, options);
    const input = { path: stateSqlitePath(state.env), env: { ...state.env } };
    const prepared = prepareSnapshot(input);
    input.path = state.statePath("replacement.sqlite");
    input.env.OPENCLAW_STATE_DIR = state.statePath("replacement-state");
    const agentPath = path.join(agentDir, "openclaw-agent.sqlite");
    const paths = expect.arrayContaining([agentPath, survivor.path]);
    await withoutHostSql(async () => {
      const { snapshot, assertCurrent } = await prepared.read();
      expect(snapshot).toMatchObject({
        retainedDeletions: {
          status: "present",
          held: [],
          entries: [{ agentId: "retired", agentDir, databasePaths: paths }],
        },
        registeredAgentDatabases: expect.arrayContaining([
          expect.objectContaining({ agentId: "survivor", path: survivor.path }),
        ]),
      });
      const isRetained = retainedMatcher(state.env, () => [], snapshot);
      expect(isRetained(survivor.path, "survivor")).toBeUndefined();
      expect(isRetained(survivor.path, "retired")).toMatchObject({ agentId: "retired" });
      expect(assertCurrent).not.toThrow();
    });
    expect(removeJournal("retired", "retained-owner", options)).toBe(true);
    expect((await prepared.read()).snapshot?.retainedDeletions).toEqual({ status: "empty" });
  });
});

it.each(["deletion", "registration removal"])(
  "allows renewed registrations but invalidates an asynchronous snapshot consumer after %s",
  async (change) => {
    await withState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const survivor = openAgentDb({ agentId: "survivor", ...options });
      const prepared = prepareSnapshot(options);
      let consumed = 0;
      await expect(
        prepared.withCurrentSnapshot(async (snapshot, assertCurrent) => {
          consumed += 1;
          expect(snapshot?.retainedDeletions).toEqual({ status: "empty" });
          assertCurrent();
          await Promise.resolve();
          registerDatabase({ agentId: "survivor", path: survivor.path, ...options });
          assertCurrent();
          if (change === "registration removal") {
            unregisterDatabase({ agentId: "survivor", path: survivor.path, ...options });
          } else {
            beginJournal(journalInput(state, "retired", "during-consumption"), options);
          }
          assertCurrent();
        }),
      ).rejects.toThrow(
        change === "deletion"
          ? "Agent database deletion snapshot changed during consumption"
          : "Agent database registry changed during discovery",
      );
      expect(consumed).toBe(1);
    });
  },
);

it.each(["source", "maintenance", "existing-schema"] as const)(
  "does not reacquire a captured deletion snapshot after its %s lifetime ends",
  async (lifetime) => {
    await withState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const database = openStateDb(options);
      const maintenance = createOpenClawDatabaseMaintenanceScope();
      try {
        const prepare = () => prepareSnapshot(options);
        if (lifetime === "existing-schema") {
          const prepared = withExistingOpenClawStateSchema({ path: database.path }, prepare);
          await expect(prepared.readWithCurrentAdmission()).rejects.toThrow(
            "Existing shared-state schema admission has ended",
          );
          return;
        }
        const prepared = maintenance.run(prepare);
        const { assertCurrent } = await prepared.read();
        expect(assertCurrent).not.toThrow();
        if (lifetime === "source") {
          await closeStateDb(database.path);
          openStateDb(options);
        } else {
          await maintenance.close();
        }
        expect(assertCurrent).toThrow();
        await expect(prepared.read()).rejects.toThrow();
        if (lifetime === "maintenance") {
          await expect(prepared.readWithCurrentAdmission()).rejects.toThrow();
        } else {
          expect((await prepared.readWithCurrentAdmission()).snapshot).toBeDefined();
        }
        expect((await prepareSnapshot(options).read()).snapshot).toBeDefined();
      } finally {
        await maintenance.close();
      }
    });
  },
);

it("keeps absent discovery conservative until its first canonical creation", async () => {
  await withState({ scenario: "empty" }, async (state) => {
    const pathname = stateSqlitePath(state.env);
    const files = [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`];
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
    const prepared = prepareSnapshot({ env: state.env });
    const result = await prepared.readWithCurrentAdmission();
    expect(result.snapshot).toBeUndefined();
    expect(result.assertCurrent).not.toThrow();
    const isRetained = retainedMatcher(state.env, () => [], result.snapshot);
    expect(isRetained(state.statePath("unknown.sqlite"), "unknown")).toBe("unavailable");
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
    openStateDb({ env: state.env });
    expect((await prepared.readWithCurrentAdmission()).snapshot).toBeDefined();
  });
});

it.each(["runtime", "runtime-discovery", "maintenance"] as const)(
  "keeps reconstructed deletion holds with their %s purpose through the native snapshot",
  async (purpose) => {
    await withState({ scenario: "minimal" }, async (state) => {
      const held = { agentId: "held", path: state.statePath("held.sqlite") };
      writeState(
        (database) => {
          database.db.exec("DROP TABLE agent_deletion_journal");
          reconstructAgentDeletionJournal(database, [held]);
        },
        { env: state.env },
      );
      const prepared = prepareSnapshot({ env: state.env }, purpose);
      await withoutHostSql(async () => {
        const { snapshot, assertCurrent } = await prepared.read();
        expect(snapshot?.retainedDeletions).toEqual(
          purpose === "maintenance"
            ? { status: "present", entries: [], held: [held] }
            : { status: "empty" },
        );
        const isRetained = retainedMatcher(state.env, () => [], snapshot, "database", purpose);
        expect(isRetained(held.path, held.agentId)).toBe(
          purpose === "maintenance" ? "held" : undefined,
        );
        expect(assertCurrent).not.toThrow();
      });
    });
  },
);
