import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  captureAgentDatabasePreparationJournal,
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { startAwaitedReadMock } from "./openclaw-state-read-mock.test-support.js";
import * as readWorker from "./openclaw-state-read-worker.js";

function deletion(state: OpenClawTestState, agentId = "worker") {
  return {
    agentId,
    operationId: `delete-${agentId}`,
    agentDir: state.agentDir(agentId),
    workspaceDir: state.workspaceDir,
    sessionsDir: state.sessionsDir(agentId),
    deleteFiles: false,
  };
}

function pending(state: OpenClawTestState, agentId = "worker") {
  return createAgentDatabaseInspectionRefusal({
    agentId,
    paths: [path.join(state.agentDir(agentId), "openclaw-agent.sqlite")],
    reason: "inspection pending",
    pending: true,
  });
}

it.each(["warm", "cold"] as const)(
  "reads exact journal absence and presence through the %s state worker",
  async (temperature) => {
    await withOpenClawTestState({ scenario: "empty" }, async (state) => {
      const options = { env: state.env };
      const pathname = resolveOpenClawStateSqlitePath(state.env);
      const files = [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`];
      expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
      await expect(readAgentDeletionJournalStatusInWorker("worker", options)).resolves.toBe(
        "absent",
      );
      expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
      openOpenClawStateDatabase(options);
      const read = async (agentId: string) => {
        if (temperature === "cold") {
          await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
        }
        const observation = observeHostDataSql();
        try {
          const calibration = openNodeSqliteDatabase(":memory:");
          try {
            calibration.exec("CREATE TABLE calibration (id INTEGER)");
            calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
            const selected = calibration.prepare("SELECT id FROM calibration");
            selected.get();
            selected.all();
            Array.from(selected.iterate());
          } finally {
            calibration.close();
          }
          for (const method of observation.calls) {
            expect(method).toHaveBeenCalled();
            method.mockClear();
          }
          observation.queries.length = 0;
          const result = await readAgentDeletionJournalStatusInWorker(agentId, options);
          expect(observation.queries).toEqual([]);
          for (const method of observation.calls) {
            expect(method).not.toHaveBeenCalled();
          }
          return result;
        } finally {
          observation.restore();
        }
      };
      await expect(read("worker")).resolves.toBe("absent");
      beginAgentDeletionJournal(deletion(state), options);
      await expect(read("WORKER")).resolves.toBe("pending");
      runOpenClawStateWriteTransaction((database) => {
        expect(completeAgentDeletionJournalInDatabase(database, "worker", "delete-worker")).toBe(
          true,
        );
      }, options);
      await expect(read("worker")).resolves.toBe("complete");
      await expect(read("other")).resolves.toBe("absent");
    });
  },
);

it.each(["rollback", "commit", "republish"] as const)(
  "publishes pending-admission invalidation only for the committed owner: %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const refusals =
        outcome === "commit" ? [pending(state), pending(state, "other")] : [pending(state)];
      const publish = () =>
        recordAgentDatabaseAdmissions(refusals, { ...options, source: "startup" });
      publish();
      const rollback = new Error("rollback outer deletion");
      const write = () =>
        runOpenClawStateWriteTransaction(() => {
          for (const refusal of refusals) {
            beginAgentDeletionJournal(deletion(state, refusal.agentId), options);
            expect(readAgentDatabaseAdmissionRefusal(refusal.agentId, options)).toBe(refusal);
          }
          if (outcome === "rollback") {
            throw rollback;
          }
          if (outcome === "republish") {
            publish();
          }
        }, options);
      if (outcome === "rollback") {
        expect(write).toThrow(rollback);
      } else {
        write();
      }
      for (const refusal of refusals) {
        const current = readAgentDatabaseAdmissionRefusal(refusal.agentId, options);
        if (outcome === "commit") {
          expect(current).toMatchObject({
            code: "agent-database-inspection-failed",
            reason: `Agent ${refusal.agentId} was deleted during startup inspection`,
          });
        } else {
          expect(current).toBe(refusal);
        }
        await expect(
          readAgentDeletionJournalStatusInWorker(refusal.agentId, options),
        ).resolves.toBe(outcome === "rollback" ? "absent" : "pending");
      }
    });
  },
);

it("invalidates known aliases of the same state without changing another state or agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { env: state.env };
    openOpenClawStateDatabase(options);
    const alias = state.path("state-alias");
    fs.symlinkSync(state.stateDir, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasOptions = { env: { ...state.env, OPENCLAW_STATE_DIR: alias } };
    const otherOptions = {
      env: { ...state.env, OPENCLAW_STATE_DIR: state.path("other-state") },
    };
    try {
      openOpenClawStateDatabase(aliasOptions);
      openOpenClawStateDatabase(otherOptions);
      const refusal = pending(state);
      const sibling = pending(state, "other");
      const foreign = pending(state);
      recordAgentDatabaseAdmissions([refusal, sibling], { ...options, source: "startup" });
      recordAgentDatabaseAdmissions([refusal], { ...aliasOptions, source: "startup" });
      recordAgentDatabaseAdmissions([foreign], { ...otherOptions, source: "startup" });
      beginAgentDeletionJournal({ ...deletion(state), agentId: "WORKER" }, aliasOptions);
      expect(readAgentDatabaseAdmissionRefusal("worker", options)?.code).toBe(
        "agent-database-inspection-failed",
      );
      expect(readAgentDatabaseAdmissionRefusal("worker", aliasOptions)?.code).toBe(
        "agent-database-inspection-failed",
      );
      expect(readAgentDatabaseAdmissionRefusal("other", options)).toBe(sibling);
      expect(readAgentDatabaseAdmissionRefusal("worker", otherOptions)).toBe(foreign);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(otherOptions.env));
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(aliasOptions.env));
    }
  });
});

it("rejects stale journal absence when deletion arrives during native read cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { env: state.env };
    openOpenClawStateDatabase(options);
    const refusal = pending(state);
    recordAgentDatabaseAdmissions([refusal], { ...options, source: "startup" });
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    let closed = false;
    const captureSource = readWorker.captureOpenClawStateReadSource;
    let selected = false;
    const transport = vi
      .spyOn(readWorker, "captureOpenClawStateReadSource")
      .mockImplementation(() => {
        const source = captureSource();
        return {
          ...source,
          createTransport(command) {
            const owned = source.createTransport(command);
            if (selected || command.type !== "agentDeletionJournal.status") {
              return owned;
            }
            selected = true;
            return {
              ...owned,
              startRead(...args) {
                return startAwaitedReadMock(async () => {
                  const outcome = await owned.startRead(...args).result;
                  expect(outcome).toMatchObject({
                    value: { ok: true, type: "agentDeletionJournal.status", status: "absent" },
                  });
                  return outcome;
                });
              },
              startClose() {
                return startAwaitedReadMock(async () => {
                  cleanupEntered.resolve();
                  await releaseCleanup.promise;
                  await owned.startClose().result;
                  closed = true;
                });
              },
            };
          },
        };
      });
    const preparation = preparePendingAgentDatabase(
      refusal,
      { ...options, assertCurrent() {} },
      async () => {
        const assertJournal = captureAgentDatabasePreparationJournal("worker", options);
        if (!assertJournal) {
          throw new Error("Expected the live startup preparation");
        }
        const journalStatus = await readAgentDeletionJournalStatusInWorker("worker", options);
        assertJournal(journalStatus !== "absent");
      },
    );
    const result = preparation.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await Promise.race([
        cleanupEntered.promise,
        result.then(() => {
          throw new Error("Journal preparation completed before held cleanup");
        }),
      ]);
      beginAgentDeletionJournal(deletion(state), options);
      releaseCleanup.resolve();
      const outcome = await result;
      expect(closed).toBe(true);
      expect(outcome).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("admission changed during preparation"),
        }),
      });
      expect(readAgentDatabaseAdmissionRefusal("worker", options)).toMatchObject({
        code: "agent-database-inspection-failed",
        reason: "Agent worker was deleted during startup inspection",
      });
    } finally {
      releaseCleanup.resolve();
      await result;
      transport.mockRestore();
    }
  });
});
