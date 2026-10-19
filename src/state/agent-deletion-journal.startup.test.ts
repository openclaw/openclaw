import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { beginAgentDeletionJournal as beginJournal } from "../test-utils/agent-deletion-journal.js";
import {
  withOpenClawTestState as withState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  captureAgentDatabasePreparationJournal as captureJournal,
  createAgentDatabaseInspectionRefusal as inspectionRefusal,
  preparePendingAgentDatabase as preparePending,
  readAgentDatabaseAdmissionRefusal as readRefusal,
  recordAgentDatabaseAdmissions as recordAdmissions,
} from "./agent-database-admission.js";
import { completeAgentDeletionJournalInDatabase as completeJournal } from "./agent-deletion-journal.js";
import { readAgentDeletionJournalStatusInWorker as readJournalStatus } from "./agent-deletion-journal.read.js";
import { journalInput as deletion, withoutHostSql } from "./agent-deletion-journal.test-support.js";
import {
  closeOpenClawStateDatabaseByPathAsync as closeStateDb,
  openOpenClawStateDatabase as openStateDb,
  runOpenClawStateWriteTransaction as writeState,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as stateSqlitePath } from "./openclaw-state-db.paths.js";
import * as readWorker from "./openclaw-state-read-worker.js";

function pending(state: OpenClawTestState, agentId = "worker") {
  return inspectionRefusal({
    agentId,
    paths: [path.join(state.agentDir(agentId), "openclaw-agent.sqlite")],
    reason: "inspection pending",
    pending: true,
  });
}

function expectDeleted(refusal: unknown, agentId: string) {
  expect(refusal).toMatchObject({
    code: "agent-database-inspection-failed",
    reason: `Agent ${agentId} was deleted during startup inspection`,
  });
}

it.each(["warm", "cold"] as const)(
  "reads exact journal absence and presence through the %s state worker",
  async (temperature) => {
    await withState({ scenario: "empty" }, async (state) => {
      const options = { env: state.env };
      const pathname = stateSqlitePath(state.env);
      const files = [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`];
      expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
      await expect(readJournalStatus("worker", options)).resolves.toBe("absent");
      expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
      openStateDb(options);
      const read = async (agentId: string) => {
        if (temperature === "cold") {
          await closeStateDb(stateSqlitePath(state.env));
        }
        return withoutHostSql(() => readJournalStatus(agentId, options));
      };
      await expect(read("worker")).resolves.toBe("absent");
      beginJournal(deletion(state), options);
      await expect(read("WORKER")).resolves.toBe("pending");
      writeState((database) => {
        expect(completeJournal(database, "worker", "delete-worker")).toBe(true);
      }, options);
      await expect(read("worker")).resolves.toBe("complete");
      await expect(read("other")).resolves.toBe("absent");
    });
  },
);

it.each(["rollback", "commit", "republish"] as const)(
  "publishes pending-admission invalidation only for the committed owner: %s",
  async (outcome) => {
    await withState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const refusals =
        outcome === "commit" ? [pending(state), pending(state, "other")] : [pending(state)];
      const publish = () => recordAdmissions(refusals, { ...options, source: "startup" });
      publish();
      const rollback = new Error("rollback outer deletion");
      const write = () =>
        writeState(() => {
          for (const refusal of refusals) {
            beginJournal(deletion(state, refusal.agentId), options);
            expect(readRefusal(refusal.agentId, options)).toBe(refusal);
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
        const current = readRefusal(refusal.agentId, options);
        if (outcome === "commit") {
          expectDeleted(current, refusal.agentId);
        } else {
          expect(current).toBe(refusal);
        }
        await expect(readJournalStatus(refusal.agentId, options)).resolves.toBe(
          outcome === "rollback" ? "absent" : "pending",
        );
      }
    });
  },
);

it("invalidates known aliases of the same state without changing another state or agent", async () => {
  await withState({ scenario: "minimal" }, async (state) => {
    const options = { env: state.env };
    openStateDb(options);
    const alias = state.path("state-alias");
    fs.symlinkSync(state.stateDir, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasOptions = { env: { ...state.env, OPENCLAW_STATE_DIR: alias } };
    const otherOptions = { env: { ...state.env, OPENCLAW_STATE_DIR: state.path("other-state") } };
    try {
      openStateDb(aliasOptions);
      openStateDb(otherOptions);
      const refusal = pending(state);
      const sibling = pending(state, "other");
      const foreign = pending(state);
      recordAdmissions([refusal, sibling], { ...options, source: "startup" });
      recordAdmissions([refusal], { ...aliasOptions, source: "startup" });
      recordAdmissions([foreign], { ...otherOptions, source: "startup" });
      beginJournal({ ...deletion(state), agentId: "WORKER" }, aliasOptions);
      expect([
        readRefusal("worker", options)?.code,
        readRefusal("worker", aliasOptions)?.code,
      ]).toEqual(["agent-database-inspection-failed", "agent-database-inspection-failed"]);
      expect(readRefusal("other", options)).toBe(sibling);
      expect(readRefusal("worker", otherOptions)).toBe(foreign);
    } finally {
      await closeStateDb(stateSqlitePath(otherOptions.env));
      await closeStateDb(stateSqlitePath(aliasOptions.env));
    }
  });
});

it("rejects stale journal absence when deletion arrives during native read cleanup", async () => {
  await withState({ scenario: "minimal" }, async (state) => {
    const options = { env: state.env };
    openStateDb(options);
    const refusal = pending(state);
    recordAdmissions([refusal], { ...options, source: "startup" });
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
              async startRead(...args) {
                const outcome = await owned.startRead(...args);
                expect(outcome).toMatchObject({
                  value: { ok: true, type: "agentDeletionJournal.status", status: "absent" },
                });
                return outcome;
              },
              async startClose() {
                cleanupEntered.resolve();
                await releaseCleanup.promise;
                await owned.startClose();
                closed = true;
              },
            };
          },
        };
      });
    const preparation = preparePending(refusal, { ...options, assertCurrent() {} }, async () => {
      const assertJournal = expectDefined(
        captureJournal("worker", options),
        "Expected live preparation",
      );
      const journalStatus = await readJournalStatus("worker", options);
      assertJournal(journalStatus !== "absent");
    });
    const rejected = expect(preparation).rejects.toThrow("admission changed during preparation");
    try {
      await awaitGateBeforeSettlement(
        cleanupEntered.promise,
        rejected,
        "Journal preparation completed before held cleanup",
      );
      beginJournal(deletion(state), options);
      releaseCleanup.resolve();
      await rejected;
      expect(closed).toBe(true);
      expectDeleted(readRefusal("worker", options), "worker");
    } finally {
      releaseCleanup.resolve();
      await rejected.finally(() => transport.mockRestore());
    }
  });
});
