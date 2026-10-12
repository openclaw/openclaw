import { afterEach, expect, it, vi } from "vitest";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import {
  beginSessionWorkAdmission,
  closeAgentWorkAdmissions,
} from "../sessions/session-lifecycle-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { invalidateAgentDeletionJournalStatus } from "./agent-deletion-journal-status.js";
import {
  beginAgentDeletionJournalInDatabase,
  completeAgentDeletionJournalInDatabase,
  deleteAgentDeletionJournalInDatabase,
} from "./agent-deletion-journal.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

afterEach(() => vi.restoreAllMocks());

it("revokes queued work and refuses the next turn after a worker deletion without rereading the journal", async () => {
  await withOpenClawTestState({ label: "deletion-status-admission" }, async (state) => {
    const options = { env: state.env };
    openOpenClawStateDatabase(options);
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const target = {
      ...options,
      agentId: "doomed",
      scope: state.sessionsDir("doomed"),
      identities: ["same-session"],
      owner: Symbol("turn"),
      serializeOwner: true,
      assertAllowed: () => {},
    };
    const first = await beginSessionWorkAdmission(target);
    first.release();
    reads.mockClear();
    const active = await beginSessionWorkAdmission(target);
    const queued = beginSessionWorkAdmission(target);
    const refused = expect(queued).rejects.toThrow("deletion");
    const reopen = closeAgentWorkAdmissions({
      ...target,
      reason: new Error("agent deletion began"),
    });
    try {
      await withAgentDeletion(
        "doomed",
        async (begin) => {
          const deletion = await begin({
            agentId: "doomed",
            agentDir: state.agentDir("doomed"),
            workspaceDir: state.path("doomed"),
            sessionsDir: state.sessionsDir("doomed"),
            phase: "draining",
          });
          await refused;
          expect(active.isActive()).toBe(true);
          await expect(beginSessionWorkAdmission(target)).rejects.toThrow("deletion");
          expect(await readAgentDeletionJournalStatusInWorker("doomed", options)).toBe("pending");
          active.release();
          await deletion.rollback();
        },
        options,
      );
      reopen();
      const resumed = await beginSessionWorkAdmission(target);
      resumed.release();
      expect(
        reads.mock.calls.filter(([, command]) => command.type === "agentDeletionJournal.status"),
      ).toEqual([]);
    } finally {
      reopen();
      active.release();
      await queued.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  });
});

it("publishes completion and recreation only on commit and reloads a discarded tombstone fact", async () => {
  await withOpenClawTestState({ label: "deletion-status-commit" }, async (state) => {
    const options = { env: state.env };
    openOpenClawStateDatabase(options);
    const input = {
      agentId: "doomed",
      operationId: "delete",
      agentDir: state.agentDir("doomed"),
      workspaceDir: state.path("doomed"),
      sessionsDir: state.sessionsDir("doomed"),
      deleteFiles: false,
    };
    const read = () => readAgentDeletionJournalStatusInWorker(input.agentId, options);
    expect(await read()).toBe("absent");
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        beginAgentDeletionJournalInDatabase(database, input);
        throw new Error("rollback");
      }, options),
    ).toThrow("rollback");
    expect(await read()).toBe("absent");
    runOpenClawStateWriteTransaction((database) => {
      beginAgentDeletionJournalInDatabase(database, input);
      completeAgentDeletionJournalInDatabase(database, input.agentId, input.operationId);
    }, options);
    expect(await read()).toBe("complete");
    invalidateAgentDeletionJournalStatus(openOpenClawStateDatabase(options).db, input.agentId);
    expect(await read()).toBe("complete");
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        deleteAgentDeletionJournalInDatabase(database, input.agentId, input.operationId, true);
        throw new Error("rollback");
      }, options),
    ).toThrow("rollback");
    expect(await read()).toBe("complete");
    runOpenClawStateWriteTransaction((database) => {
      deleteAgentDeletionJournalInDatabase(database, input.agentId, input.operationId, true);
    }, options);
    expect(await read()).toBe("absent");
  });
});
