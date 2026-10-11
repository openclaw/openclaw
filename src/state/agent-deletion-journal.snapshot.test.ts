import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRetainedAgentDatabaseMatcherFromSnapshot } from "./agent-deletion-discovery.js";
import { reconstructAgentDeletionJournal } from "./agent-deletion-journal-recovery.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "./agent-deletion-journal.read.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

it("reads fresh deletion and surviving-owner facts from its captured source without host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const survivor = openOpenClawAgentDatabase({ agentId: "survivor", env: state.env });
    const agentDir = state.agentDir("retired");
    const options = { env: state.env };
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "retained-owner",
        agentDir,
        workspaceDir: state.workspaceDir,
        sessionsDir: state.sessionsDir("retired"),
        databasePaths: [survivor.path],
        deleteFiles: false,
      },
      options,
    );
    runOpenClawStateWriteTransaction((database) => {
      expect(completeAgentDeletionJournalInDatabase(database, "retired", "retained-owner")).toBe(
        true,
      );
    }, options);
    const input = {
      path: resolveOpenClawStateSqlitePath(state.env),
      env: { ...state.env },
    };
    const prepared = prepareAgentDatabaseDeletionSnapshotRead(input);
    input.path = state.statePath("replacement.sqlite");
    input.env.OPENCLAW_STATE_DIR = state.statePath("replacement-state");
    const observation = observeHostDataSql();
    try {
      const { snapshot, assertCurrent } = await prepared.read();
      expect(snapshot).toMatchObject({
        retainedDeletions: {
          status: "present",
          held: [],
          entries: [
            {
              agentId: "retired",
              agentDir,
              databasePaths: expect.arrayContaining([
                path.join(agentDir, "openclaw-agent.sqlite"),
                survivor.path,
              ]),
            },
          ],
        },
        registeredAgentDatabases: expect.arrayContaining([
          expect.objectContaining({ agentId: "survivor", path: survivor.path }),
        ]),
      });
      const isRetained = createRetainedAgentDatabaseMatcherFromSnapshot(
        state.env,
        () => [],
        snapshot,
      );
      expect(isRetained(survivor.path, "survivor")).toBeUndefined();
      expect(isRetained(survivor.path, "retired")).toMatchObject({ agentId: "retired" });
      expect(assertCurrent).not.toThrow();
      expect(observation.queries).toEqual([]);
      for (const call of observation.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      observation.restore();
    }
    expect(removeAgentDeletionJournal("retired", "retained-owner", options)).toBe(true);
    expect((await prepared.read()).snapshot?.retainedDeletions).toEqual({ status: "empty" });
  });
});

it.each(["deletion", "registration removal"])(
  "allows renewed registrations but invalidates an asynchronous snapshot consumer after %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const survivor = openOpenClawAgentDatabase({ agentId: "survivor", ...options });
      const prepared = prepareAgentDatabaseDeletionSnapshotRead(options);
      let consumed = 0;
      await expect(
        prepared.withCurrentSnapshot(async (snapshot, assertCurrent) => {
          consumed += 1;
          expect(snapshot?.retainedDeletions).toEqual({ status: "empty" });
          assertCurrent();
          await Promise.resolve();
          registerOpenClawAgentDatabase({ agentId: "survivor", path: survivor.path, ...options });
          assertCurrent();
          if (change === "registration removal") {
            unregisterOpenClawAgentDatabase({
              agentId: "survivor",
              path: survivor.path,
              ...options,
            });
          } else {
            beginAgentDeletionJournal(
              {
                agentId: "retired",
                operationId: "during-consumption",
                agentDir: state.agentDir("retired"),
                workspaceDir: state.workspaceDir,
                sessionsDir: state.sessionsDir("retired"),
                deleteFiles: false,
              },
              options,
            );
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const database = openOpenClawStateDatabase(options);
      const maintenance = createOpenClawDatabaseMaintenanceScope();
      try {
        const prepare = () => prepareAgentDatabaseDeletionSnapshotRead(options);
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
          await closeOpenClawStateDatabaseByPathAsync(database.path);
          openOpenClawStateDatabase(options);
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
        expect(
          (await prepareAgentDatabaseDeletionSnapshotRead(options).read()).snapshot,
        ).toBeDefined();
      } finally {
        await maintenance.close();
      }
    });
  },
);

it("keeps absent discovery conservative until its first canonical creation", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const pathname = resolveOpenClawStateSqlitePath(state.env);
    const files = [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`];
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
    const prepared = prepareAgentDatabaseDeletionSnapshotRead({ env: state.env });
    const result = await prepared.readWithCurrentAdmission();
    expect(result.snapshot).toBeUndefined();
    expect(result.assertCurrent).not.toThrow();
    const isRetained = createRetainedAgentDatabaseMatcherFromSnapshot(
      state.env,
      () => [],
      result.snapshot,
    );
    expect(isRetained(state.statePath("unknown.sqlite"), "unknown")).toBe("unavailable");
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
    openOpenClawStateDatabase({ env: state.env });
    expect((await prepared.readWithCurrentAdmission()).snapshot).toBeDefined();
  });
});

it.each(["runtime", "maintenance"] as const)(
  "keeps reconstructed deletion holds with their %s purpose through the native snapshot",
  async (purpose) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const held = { agentId: "held", path: state.statePath("held.sqlite") };
      runOpenClawStateWriteTransaction(
        (database) => {
          database.db.exec("DROP TABLE agent_deletion_journal");
          reconstructAgentDeletionJournal(database, [held]);
        },
        { env: state.env },
      );
      const prepared = prepareAgentDatabaseDeletionSnapshotRead({ env: state.env }, purpose);
      const observation = observeHostDataSql();
      try {
        const { snapshot, assertCurrent } = await prepared.read();
        expect(snapshot?.retainedDeletions).toEqual(
          purpose === "maintenance"
            ? { status: "present", entries: [], held: [held] }
            : { status: "empty" },
        );
        const isRetained = createRetainedAgentDatabaseMatcherFromSnapshot(
          state.env,
          () => [],
          snapshot,
          "database",
          purpose,
        );
        expect(isRetained(held.path, held.agentId)).toBe(
          purpose === "maintenance" ? "held" : undefined,
        );
        expect(assertCurrent).not.toThrow();
        expect(observation.queries).toEqual([]);
        for (const call of observation.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        observation.restore();
      }
    });
  },
);
