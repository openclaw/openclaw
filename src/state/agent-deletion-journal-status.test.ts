import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { isAgentDeletionBlocked, withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import { prepareSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  beginSessionWorkAdmission,
  closeAgentWorkAdmissions,
} from "../sessions/session-lifecycle-admission.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getPreparedAgentDeletionDiscovery,
  invalidateAgentDeletionJournalStatus,
  seedAgentDeletionDiscovery,
} from "./agent-deletion-journal-status.js";
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

function agentFixture(state: OpenClawTestState, agentId = "doomed") {
  const options = { env: state.env };
  const database = openOpenClawStateDatabase(options);
  const paths = {
    agentId,
    agentDir: state.agentDir(agentId),
    workspaceDir: state.path(agentId),
    sessionsDir: state.sessionsDir(agentId),
  };
  return {
    options,
    database,
    paths,
    read: () => readAgentDeletionJournalStatusInWorker(agentId, options),
    blocked(expected: boolean) {
      const sql = observeHostDataSql();
      try {
        expect(isAgentDeletionBlocked(agentId, options)).toBe(expected);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    },
    async deleting(run: () => Promise<void>) {
      await withAgentDeletion(
        agentId,
        async (begin) => {
          const deletion = await begin({ ...paths, phase: "draining" });
          try {
            await run();
          } finally {
            await deletion.rollback();
          }
        },
        options,
      );
    },
  };
}

it("revokes queued work and refuses the next turn after a worker deletion without rereading the journal", async () => {
  await withOpenClawTestState({ label: "deletion-status-admission" }, async (state) => {
    const fixture = agentFixture(state);
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const target = {
      ...fixture.options,
      agentId: "doomed",
      scope: state.sessionsDir("doomed"),
      identities: ["same-session"],
      owner: Symbol("turn"),
      serializeOwner: true,
      assertAllowed: () => {},
    };
    const first = await beginSessionWorkAdmission(target);
    first.release();
    const directReads = vi.spyOn(stateReads, "withExistingOpenClawStateDatabaseCurrentReadOnly");
    expect(isAgentDeletionBlocked("doomed", fixture.options)).toBe(false);
    expect(directReads).not.toHaveBeenCalled();
    reads.mockClear();
    const active = await beginSessionWorkAdmission(target);
    const queued = beginSessionWorkAdmission(target);
    const refused = expect(queued).rejects.toThrow("deletion");
    const reopen = closeAgentWorkAdmissions({
      ...target,
      reason: new Error("agent deletion began"),
    });
    try {
      await fixture.deleting(async () => {
        await refused;
        expect(active.isActive()).toBe(true);
        await expect(beginSessionWorkAdmission(target)).rejects.toThrow("deletion");
        expect(await fixture.read()).toBe("pending");
        directReads.mockClear();
        expect(isAgentDeletionBlocked("doomed", fixture.options)).toBe(true);
        expect(directReads).not.toHaveBeenCalled();
        active.release();
      });
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

it("denies cold authority and publishes completion and recreation only on commit", async () => {
  await withOpenClawTestState({ label: "deletion-status-commit" }, async (state) => {
    const fixture = agentFixture(state);
    const input = {
      ...fixture.paths,
      operationId: "delete",
      deleteFiles: false,
    };
    fixture.blocked(true);
    expect(await fixture.read()).toBe("absent");
    fixture.blocked(false);
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        beginAgentDeletionJournalInDatabase(database, input);
        fixture.blocked(true);
        throw new Error("rollback");
      }, fixture.options),
    ).toThrow("rollback");
    expect(await fixture.read()).toBe("absent");
    runOpenClawStateWriteTransaction((database) => {
      beginAgentDeletionJournalInDatabase(database, input);
      completeAgentDeletionJournalInDatabase(database, input.agentId, input.operationId);
    }, fixture.options);
    expect(await fixture.read()).toBe("complete");
    expect(isAgentDeletionBlocked(input.agentId, fixture.options)).toBe(true);
    const stateDatabase = fixture.database;
    invalidateAgentDeletionJournalStatus(stateDatabase.db, input.agentId);
    fixture.blocked(true);
    seedAgentDeletionDiscovery(stateDatabase.path, {
      status: "unavailable",
      cause: "unreadable",
      reason: "synthetic unavailable read",
    });
    expect(getPreparedAgentDeletionDiscovery(stateDatabase.path)).toBeUndefined();
    expect(await fixture.read()).toBe("complete");
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        deleteAgentDeletionJournalInDatabase(database, input.agentId, input.operationId, true);
        expect(isAgentDeletionBlocked(input.agentId, fixture.options)).toBe(false);
        throw new Error("rollback");
      }, fixture.options),
    ).toThrow("rollback");
    expect(await fixture.read()).toBe("complete");
    runOpenClawStateWriteTransaction((database) => {
      deleteAgentDeletionJournalInDatabase(database, input.agentId, input.operationId, true);
    }, fixture.options);
    expect(await fixture.read()).toBe("absent");
  });
});

it.each(["before-read", "during-read", "revoked-read"] as const)(
  "prepares an overlapping roster without retiring credentials (%s)",
  async (timing) => {
    await withOpenClawTestState({ label: "secrets-retiring-roster" }, async (state) => {
      const agentId = "retiring";
      const fixture = agentFixture(state, agentId);
      const agentDir = state.agentDir(agentId);
      const healthyDir = state.agentDir("main");
      const config = { agents: { entries: { main: {}, [agentId]: {} } } };
      const entered = createDeferred();
      const release = createDeferred();
      const loadAuthStore = vi.fn(async (dir?: string) => {
        if (dir === agentDir && timing !== "before-read") {
          entered.resolve();
          await release.promise;
          if (timing === "revoked-read") {
            throw new Error("Auth profile reader owner was revoked");
          }
        }
        return {
          version: 1,
          profiles: {
            "custom:healthy": { type: "api_key" as const, provider: "custom", key: "fixture-key" },
          },
        };
      });
      const prepare = () =>
        prepareSecretsRuntimeSnapshot({
          config,
          env: state.env,
          agentDirs: [healthyDir, agentDir],
          includeConfigRefs: false,
          loadAuthStore,
        });
      const inFlight = timing === "before-read" ? undefined : prepare();
      void inFlight?.catch(() => {});
      try {
        if (inFlight) {
          await entered.promise;
        }
        await fixture.deleting(async () => {
          release.resolve();
          const snapshot = await (inFlight ?? prepare());
          expect(snapshot.authStores.map((entry) => entry.agentDir)).toEqual([healthyDir]);
          expect(snapshot.authStores[0]?.store.profiles["custom:healthy"]).toMatchObject({
            key: "fixture-key",
          });
          expect(listConfiguredOwnerInputs(config).map((input) => input.agentId)).toEqual(["main"]);
          if (timing === "before-read") {
            expect(loadAuthStore).not.toHaveBeenCalledWith(agentDir);
          }
        });
        expect(listConfiguredOwnerInputs(config).map((input) => input.agentId)).toEqual([
          "main",
          agentId,
        ]);
      } finally {
        release.resolve();
        await inFlight?.catch(() => {});
      }
    });
  },
);
