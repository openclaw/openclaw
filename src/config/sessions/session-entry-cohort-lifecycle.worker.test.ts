import fs from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import {
  loadSessionEntry,
  patchSessionEntryTarget,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { loadExactSessionEntryReadOnly } from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope, SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";
import { addSessionMember } from "./session-sharing-store.native.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

function createCohortFixture(name: string) {
  const scope = {
    agentId: "cohort",
    env: state.env,
    storePath: state.statePath("admitted-cohort", name, "sessions.json"),
    sessionKey: `agent:cohort:${name}`,
  };
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1 };
  replaceSessionEntrySync(scope, entry);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return { scope, entry, database };
}

async function admitCohort(scope: SessionAccessScope) {
  const loaded = await loadSessionEntryForAdmission(scope);
  const claim = loaded.databaseClaim;
  if (!("reader" in claim) || !claim.reader) {
    await claim.release();
    throw new Error("Expected a durable admission reader");
  }
  return { claim, reader: claim.reader };
}

function holdCohortReply() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let armed = false;
  const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
  const intercept = vi
    .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const execution = capture(...args);
      return {
        ...execution,
        get fileIdentity() {
          return execution.fileIdentity;
        },
        async runExisting<T>(
          source: AgentDatabaseRequestExecutionSource,
          operation: (worker: AgentDatabaseExecutionScope) => Promise<T>,
          options?: Parameters<OpenClawAgentDatabaseExecution["runExisting"]>[2],
        ): Promise<T | undefined> {
          return execution.runExisting(
            source,
            async (worker) => {
              const execute: typeof worker.execute = async (command, requestOptions) => {
                const result = await worker.execute(command, requestOptions);
                if (armed) {
                  armed = false;
                  entered.resolve();
                  await release.promise;
                }
                return result;
              };
              return operation({ execute });
            },
            options,
          );
        },
      };
    });
  return {
    entered,
    release,
    arm: () => {
      armed = true;
    },
    restore: () => intercept.mockRestore(),
  };
}

it("refreshes admitted cohorts after a known write and a foreign membership commit between phases", async () => {
  const { scope, database } = createCohortFixture("fresh-phases");
  const identity = readOpenClawAgentDatabaseIdentity(database);
  addSessionMember(scope, { identityId: "original-member", addedBy: "owner", addedAt: 1 });
  const { claim, reader } = await admitCohort(scope);
  const request = { sessionKeys: [scope.sessionKey], includeMembers: true, snapshotFields: [] };
  const external = createDeferredCore();
  let following: Promise<unknown> | undefined;
  const peer = openNodeSqliteDatabase(database.path);
  const observer = observeParentSqlite();
  let escaped: (() => void) | undefined;
  try {
    await reader.withRead(
      request,
      () => {},
      (read, assertCurrent) => {
        assertCurrent();
        escaped = assertCurrent;
        expect(read.members?.[scope.sessionKey]?.map(({ identityId }) => identityId)).toEqual([
          "original-member",
        ]);
      },
    );
    expect(observer.counts).toEqual(emptySqliteCounts());
    expect(escaped).toThrow("consumption has ended");
    let readTarget: SessionEntryTargetPatchScope | undefined;
    const recordReadTarget = (target: SessionEntryTargetPatchScope) => {
      readTarget = target;
    };
    await expect(
      readSessionEntryInWorker(scope, () => {}, undefined, recordReadTarget, reader),
    ).resolves.toMatchObject({ sessionId: "fresh-phases", lifecycleRevision: "original" });
    if (!readTarget) {
      throw new Error("Writable cohort read omitted its physical target");
    }
    expect(readTarget).toMatchObject({
      agentId: scope.agentId,
      storePath: database.path,
      readSource: {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
      },
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });
    expect(observer.counts).toEqual(emptySqliteCounts());
    following = external.promise.then(() =>
      reader.withRead(
        request,
        () => {},
        (read) => {
          expect(read.entries[0]?.entry).toMatchObject({ label: "known write" });
          expect(read.members?.[scope.sessionKey]?.map(({ identityId }) => identityId)).toEqual([
            "foreign-member",
          ]);
        },
      ),
    );
    // Completing the writer before releasing the external wait proves no FIFO is held between phases.
    await patchSessionEntryTarget(readTarget, () => ({ label: "known write" }), {
      skipMaintenance: true,
    });
    peer.prepare("DELETE FROM session_members WHERE session_key = ?").run(scope.sessionKey);
    peer
      .prepare(`INSERT INTO session_members (session_key, identity_id, added_by, added_at)
      VALUES (?, 'foreign-member', 'other-process', 2)`)
      .run(scope.sessionKey);
    observer.reset();
    external.resolve();
    await following;
    expect(observer.counts).toEqual(emptySqliteCounts());
    await expect(
      reader.withRead(
        request,
        () => {},
        async () => undefined,
      ),
    ).rejects.toThrow("consumers must remain synchronous");
    await claim.release();
    readTarget = undefined;
    await expect(
      readSessionEntryInWorker(scope, () => {}, undefined, recordReadTarget, reader),
    ).rejects.toThrow(/released|closed|revoked/iu);
    expect(readTarget).toBeUndefined();
  } finally {
    observer.restore();
    external.resolve();
    await Promise.allSettled(following ? [following] : []);
    peer.close();
    await claim.release();
  }
});

it.each(["reset", "delete", "physical replacement", "release"] as const)(
  "refuses an admitted cohort after %s without consuming stale rows",
  async (change) => {
    const { scope, entry, database } = createCohortFixture(`revoke-${change.replaceAll(" ", "-")}`);
    const { claim, reader } = await admitCohort(scope);
    const consume = vi.fn();
    try {
      if (change === "reset") {
        replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "successor" });
      } else if (change === "delete") {
        database.db
          .prepare("DELETE FROM session_nodes WHERE session_key = ?")
          .run(scope.sessionKey);
      } else if (change === "physical replacement") {
        fs.copyFileSync(database.path, `${database.path}.replacement`);
        fs.renameSync(`${database.path}.replacement`, database.path);
      } else {
        await claim.release();
      }
      await expect(
        reader.withRead({ sessionKeys: [scope.sessionKey] }, () => {}, consume),
      ).rejects.toThrow(/changed|replaced|released|closed/iu);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await claim.release();
    }
  },
);

it.each(["native mutation", "caller revocation"] as const)(
  "rejects %s after the worker reply and before cohort consumption",
  async (change) => {
    const { scope, database } = createCohortFixture(`late-${change.replaceAll(" ", "-")}`);
    if (change === "native mutation") {
      addSessionMember(scope, { identityId: "native-member", addedBy: "owner", addedAt: 1 });
    }
    const gate = holdCohortReply();
    let claim: Awaited<ReturnType<typeof admitCohort>>["claim"] | undefined;
    let reading: Promise<unknown> | undefined;
    const consume = vi.fn();
    let allowed = true;
    try {
      const admitted = await admitCohort(scope);
      claim = admitted.claim;
      addSessionMember(scope, { identityId: "reply-member", addedBy: "owner", addedAt: 2 });
      gate.arm();
      reading = admitted.reader.withRead(
        { sessionKeys: [scope.sessionKey], includeMembers: true },
        () => {
          if (!allowed) {
            throw new Error("Cohort caller was revoked");
          }
        },
        consume,
      );
      void reading.catch(() => {});
      await awaitGateBeforeSettlement(
        gate.entered.promise,
        reading,
        "Cohort settled before its reply gate",
      );
      if (change === "native mutation") {
        // The synchronous SDK can write without entering the FIFO or publishing sessionChanges.
        const mutation = database.db
          .prepare(
            "UPDATE session_members SET added_at = added_at + 1 WHERE session_key = ? AND identity_id = 'native-member'",
          )
          .run(scope.sessionKey);
        expect(mutation.changes).toBe(1);
      } else {
        allowed = false;
      }
      gate.release.resolve();
      await expect(reading).rejects.toThrow(
        change === "native mutation" ? /changed during read/u : /caller was revoked/u,
      );
      expect(consume).not.toHaveBeenCalled();
      if (change === "native mutation") {
        const mutateDuringConsumption = vi.fn(() => {
          const mutation = database.db
            .prepare(
              "UPDATE session_members SET added_at = added_at + 1 WHERE session_key = ? AND identity_id = 'native-member'",
            )
            .run(scope.sessionKey);
          expect(mutation.changes).toBe(1);
          return "must not escape the final witness";
        });
        await expect(
          admitted.reader.withRead(
            { sessionKeys: [scope.sessionKey], includeMembers: true },
            () => {},
            mutateDuringConsumption,
          ),
        ).rejects.toThrow("Session entry changed during read");
        expect(mutateDuringConsumption).toHaveBeenCalledOnce();
      }
    } finally {
      gate.release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      await claim?.release();
      gate.restore();
    }
  },
);

it.each(["release", "close"] as const)(
  "joins an accepted cohort reply before completing %s",
  async (ending) => {
    const { scope, database } = createCohortFixture(`join-${ending}`);
    const gate = holdCohortReply();
    let claim: Awaited<ReturnType<typeof admitCohort>>["claim"] | undefined;
    let reading: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    const consume = vi.fn();
    try {
      const admitted = await admitCohort(scope);
      claim = admitted.claim;
      addSessionMember(scope, { identityId: "reply-member", addedBy: "owner", addedAt: 2 });
      gate.arm();
      reading = admitted.reader.withRead(
        { sessionKeys: [scope.sessionKey], includeMembers: true },
        () => {},
        consume,
      );
      void reading.catch(() => {});
      await awaitGateBeforeSettlement(
        gate.entered.promise,
        reading,
        "Cohort settled before its reply gate",
      );
      let closed = false;
      closing = (
        ending === "release"
          ? claim.release()
          : closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId)
      ).then(() => {
        closed = true;
      });
      await expect(
        admitted.reader.withRead({ sessionKeys: [scope.sessionKey] }, () => {}, consume),
      ).rejects.toThrow(/released|closed|revoked/iu);
      expect(closed).toBe(false);
      gate.release.resolve();
      await expect(reading).rejects.toThrow(/released|closed|revoked/iu);
      await closing;
      expect(closed).toBe(true);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      gate.release.resolve();
      await Promise.allSettled([...(reading ? [reading] : []), ...(closing ? [closing] : [])]);
      await claim?.release();
      gate.restore();
    }
  },
);

it.for(["release", "physical close"] as const)(
  "cancels and joins a host-queued cohort before %s completes",
  async (ending, { signal }) => {
    const { scope, database, entry } = createCohortFixture(
      `host-queued-${ending.replaceAll(" ", "-")}`,
    );
    const { claim, reader } = await admitCohort(scope);
    const entered = createDeferredCore();
    const releaseWriter = createDeferredCore();
    const consume = vi.fn();
    let writer: Promise<void> | undefined;
    let reading: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await expect(
        reader.withRead(
          { sessionKeys: [scope.sessionKey] },
          () => {},
          (read) => {
            expect(read.entries[0]?.entry.sessionId).toBe(entry.sessionId);
          },
        ),
      ).resolves.toBeUndefined();
      writer = runOpenClawAgentWorkerWrite(reader.database, async () => {
        entered.resolve();
        await releaseWriter.promise;
      });
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, writer, "Host FIFO blocker did not enter"),
        signal,
      );
      reading = reader.withRead({ sessionKeys: [scope.sessionKey] }, () => {}, consume);
      let readSettled = false;
      void reading.then(
        () => {
          readSettled = true;
        },
        () => {
          readSettled = true;
        },
      );
      let closed = false;
      closing = (
        ending === "release"
          ? claim.release()
          : closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId)
      ).then(() => {
        expect(readSettled).toBe(true);
        closed = true;
      });
      // Cancellation settles the queued phase while the unrelated predecessor still holds FIFO.
      await expect(withinTest(reading, signal)).rejects.toThrow(/released|closed|revoked/iu);
      await expect(
        reader.withRead({ sessionKeys: [scope.sessionKey] }, () => {}, consume),
      ).rejects.toThrow(/released|closed|revoked/iu);
      releaseWriter.resolve();
      await withinTest(writer, signal);
      await withinTest(closing, signal);
      expect(closed).toBe(true);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      releaseWriter.resolve();
      await Promise.allSettled([writer, reading, closing]);
      await claim.release();
    }
  },
);

it("refuses malformed folded candidate state while retaining the healthy requested row", async () => {
  const scope = {
    agentId: "aliases",
    env: state.env,
    sessionKey: "agent:aliases:matrix:group:!Room:example.org",
  };
  const folded = "agent:aliases:matrix:group:!room:example.org";
  replaceSessionEntrySync(scope, { sessionId: "healthy", updatedAt: 1 });
  replaceSessionEntrySync({ ...scope, sessionKey: folded }, { sessionId: "broken", updatedAt: 1 });
  expect(loadExactSessionEntryReadOnly(scope)?.entry.sessionId).toBe("healthy");
  const database = openOpenClawAgentDatabase(scope);
  const { claim, reader } = await admitCohort(scope);
  const read = () =>
    reader.withRead(
      { sessionKeys: [scope.sessionKey] },
      () => {},
      (cohort) =>
        cohort.entries.map(({ sessionKey, entry }) => ({ sessionKey, sessionId: entry.sessionId })),
    );
  try {
    await expect(read()).resolves.toEqual([{ sessionKey: scope.sessionKey, sessionId: "healthy" }]);
    const foreign = openNodeSqliteDatabase(database.path);
    try {
      expect(
        foreign
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run("{", folded).changes,
      ).toBe(1);
    } finally {
      foreign.close();
    }
    // The selected row is unchanged; this phase must still refuse its corrupted folded guard.
    await expect(read()).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
    });
    await expect(Promise.resolve().then(() => loadSessionEntry(scope))).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
    });
    await expect(readSessionEntryInWorker(scope, () => {})).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
    });
  } finally {
    await claim.release();
  }
});
