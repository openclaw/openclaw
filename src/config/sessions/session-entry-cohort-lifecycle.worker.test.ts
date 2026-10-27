import { AsyncResource } from "node:async_hooks";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeDatabase,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWorkerWrite as runWorkerWrite,
  runOpenClawAgentWriteAdmission as holdWriter,
} from "../../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryForAdmission as loadAdmission } from "./session-accessor.sqlite-entry-admission.js";
import {
  loadSessionEntry,
  patchSessionEntryTarget as patchTarget,
  replaceSessionEntrySync as seed,
} from "./session-accessor.sqlite-entry.js";
import { loadExactSessionEntryReadOnly as loadExact } from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope, SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import {
  readSessionEntryInWorker as readEntry,
  readSessionEntryReadOnlyInWorker as readOnlyEntry,
} from "./session-entry-read-runtime.js";
import { addSessionMember } from "./session-sharing-store.native.js";

let state: OpenClawTestState;
const noop = () => {};
const revoked = /released|closed|revoked/iu;
const requestFor = (scope: SessionAccessScope) => ({ sessionKeys: [scope.sessionKey] });
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

function fixture(name: string) {
  const scope = {
    agentId: "cohort",
    env: state.env,
    storePath: state.statePath("admitted-cohort", name, "sessions.json"),
    sessionKey: `agent:cohort:${name}`,
  };
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1 };
  seed(scope, entry);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return { scope, entry, database };
}

async function admitCohort(scope: SessionAccessScope) {
  const loaded = await loadAdmission(scope);
  const claim = loaded.databaseClaim;
  if (!("reader" in claim) || !claim.reader) {
    await claim.release();
    throw new Error("Expected a durable admission reader");
  }
  onTestFinished(() => claim.release());
  return { claim, reader: claim.reader };
}

async function startGatedRead(scope: SessionAccessScope, assertCurrent = noop) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let armed = false;
  const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
  const intercept = vi
    .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const execution = capture(...args);
      const runExisting = execution.runExisting.bind(execution);
      execution.runExisting = (source, operation, options) =>
        runExisting(
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
      return execution;
    });
  onTestFinished(() => intercept.mockRestore());
  const admitted = await admitCohort(scope);
  addSessionMember(scope, { identityId: "reply-member", addedBy: "owner", addedAt: 2 });
  armed = true;
  const consume = vi.fn();
  const reading = admitted.reader.withRead(
    { ...requestFor(scope), includeMembers: true },
    assertCurrent,
    consume,
  );
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled([reading]);
  });
  void reading.catch(noop);
  await awaitGateBeforeSettlement(entered.promise, reading, "Cohort settled before its reply gate");
  return { ...admitted, gate: { release }, reading, consume };
}

it.for(["warm", "cold"] as const)(
  "returns %s admitted entry data without waiting for another writer and refreshes committed facts",
  async (cache, { signal }) => {
    const { scope, entry, database } = fixture(`data-read-fifo-${cache}`);
    const { reader } = await admitCohort(scope);
    if (cache === "cold") {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify(entry), scope.sessionKey);
    }
    const outside = AsyncResource.bind(<T>(run: () => T) => run());
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const writer = holdWriter(
      { agentId: database.agentId, path: database.path, env: scope.env },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let reads: Promise<unknown> | undefined = undefined;
    onTestFinished(async () => {
      release.resolve();
      await Promise.allSettled([writer, reads]);
    });
    await withinTest(entered.promise, signal);
    reads = outside(() =>
      Promise.all([
        readEntry(scope, noop, undefined, undefined, reader),
        readOnlyEntry(scope, noop, reader),
      ]),
    );
    expect(
      await withinTest(
        awaitGateBeforeSettlement(reads, writer, "Writer released before admitted data read"),
        signal,
      ),
    ).toMatchObject([entry, entry]);
    release.resolve();
    await writer;
    seed(scope, { ...entry, label: "committed update" });
    await expect(readOnlyEntry(scope, noop, reader)).resolves.toMatchObject({
      label: "committed update",
    });
  },
);

it("refreshes admitted cohorts after a known write and a foreign membership commit between phases", async () => {
  const { scope, database } = fixture("fresh-phases");
  addSessionMember(scope, { identityId: "original-member", addedBy: "owner", addedAt: 1 });
  const { claim, reader } = await admitCohort(scope);
  const request = { ...requestFor(scope), includeMembers: true, snapshotFields: [] };
  const external = createDeferredCore();
  let following: Promise<unknown> | undefined = undefined;
  const peer = openNodeSqliteDatabase(database.path);
  const observer = observeParentSqlite();
  let escaped: (() => void) | undefined;
  onTestFinished(async () => {
    observer.restore();
    external.resolve();
    await Promise.allSettled([following]);
    peer.close();
  });
  await reader.withRead(request, noop, (read, assertCurrent) => {
    assertCurrent();
    escaped = assertCurrent;
    expect(read.members?.[scope.sessionKey]?.map(({ identityId }) => identityId)).toEqual([
      "original-member",
    ]);
  });
  expect(observer.counts).toEqual(emptySqliteCounts());
  expect(escaped).toThrow("consumption has ended");
  let readTarget: SessionEntryTargetPatchScope | undefined;
  const recordReadTarget = (target: SessionEntryTargetPatchScope) => {
    readTarget = target;
  };
  await expect(readEntry(scope, noop, undefined, recordReadTarget, reader)).resolves.toMatchObject({
    sessionId: "fresh-phases",
    lifecycleRevision: "original",
  });
  if (!readTarget) {
    throw new Error("Writable cohort read omitted its physical target");
  }
  expect(observer.counts).toEqual(emptySqliteCounts());
  following = external.promise.then(() =>
    reader.withRead(request, noop, (read) => {
      expect(read.entries[0]?.entry).toMatchObject({ label: "known write" });
      expect(read.members?.[scope.sessionKey]?.map(({ identityId }) => identityId)).toEqual([
        "foreign-member",
      ]);
    }),
  );
  // Completing the writer before releasing the external wait proves no FIFO is held between phases.
  await patchTarget(readTarget, () => ({ label: "known write" }), { skipMaintenance: true });
  peer.prepare("DELETE FROM session_members WHERE session_key = ?").run(scope.sessionKey);
  peer
    .prepare(`INSERT INTO session_members (session_key, identity_id, added_by, added_at)
      VALUES (?, 'foreign-member', 'other-process', 2)`)
    .run(scope.sessionKey);
  observer.reset();
  external.resolve();
  await following;
  expect(observer.counts).toEqual(emptySqliteCounts());
  await expect(reader.withRead(request, noop, async () => undefined)).rejects.toThrow(
    "consumers must remain synchronous",
  );
  await claim.release();
  readTarget = undefined;
  await expect(readEntry(scope, noop, undefined, recordReadTarget, reader)).rejects.toThrow(
    revoked,
  );
  expect(readTarget).toBeUndefined();
});

it.each(["reset", "delete"] as const)(
  "refuses an admitted cohort after %s without consuming stale rows",
  async (change) => {
    const { scope, entry, database } = fixture(`revoke-${change.replaceAll(" ", "-")}`);
    const { reader } = await admitCohort(scope);
    const consume = vi.fn();
    if (change === "reset") {
      seed(scope, { ...entry, lifecycleRevision: "successor" });
    } else {
      database.db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(scope.sessionKey);
    }
    await expect(reader.withRead(requestFor(scope), noop, consume)).rejects.toThrow(
      /changed|replaced|released|closed/iu,
    );
    expect(consume).not.toHaveBeenCalled();
  },
);

it.each(["native mutation", "caller revocation"] as const)(
  "rejects %s after the worker reply and before cohort consumption",
  async (change) => {
    const { scope, database } = fixture(`late-${change.replaceAll(" ", "-")}`);
    if (change === "native mutation") {
      addSessionMember(scope, { identityId: "native-member", addedBy: "owner", addedAt: 1 });
    }
    let allowed = true;
    const { reader, gate, reading, consume } = await startGatedRead(scope, () => {
      if (!allowed) {
        throw new Error("Cohort caller was revoked");
      }
    });
    const mutate = () => {
      // Native SDK writes bypass FIFO and sessionChanges publication.
      database.db
        .prepare(
          "UPDATE session_members SET added_at = added_at + 1 WHERE session_key = ? AND identity_id = 'native-member'",
        )
        .run(scope.sessionKey);
    };
    if (change === "native mutation") {
      mutate();
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
        mutate();
        return "must not escape the final witness";
      });
      await expect(
        reader.withRead(
          { ...requestFor(scope), includeMembers: true },
          noop,
          mutateDuringConsumption,
        ),
      ).rejects.toThrow("Session entry changed during read");
      expect(mutateDuringConsumption).toHaveBeenCalledOnce();
    }
  },
);

async function startQueuedRead(scope: SessionAccessScope, signal: AbortSignal) {
  const { claim, reader } = await admitCohort(scope);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const consume = vi.fn();
  let writer: Promise<void> | undefined = undefined;
  let reading: Promise<unknown> | undefined = undefined;
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled([writer, reading]);
  });
  await reader.withRead(requestFor(scope), noop, noop);
  writer = runWorkerWrite(reader.database, async () => {
    entered.resolve();
    await release.promise;
  });
  await withinTest(
    awaitGateBeforeSettlement(entered.promise, writer, "Host FIFO blocker did not enter"),
    signal,
  );
  reading = reader.withRead(requestFor(scope), noop, consume);
  return { claim, reader, gate: { release }, reading, consume, writer };
}

it.for([
  { phase: "reply", ending: "release" },
  { phase: "reply", ending: "close" },
  { phase: "queue", ending: "release" },
  { phase: "queue", ending: "close" },
] as const)(
  "joins a $phase cohort before $ending completes",
  async ({ phase, ending }, { signal }) => {
    const { scope, database } = fixture(`join-${phase}-${ending}`);
    const { claim, reader, gate, reading, consume, writer } =
      phase === "queue"
        ? await startQueuedRead(scope, signal)
        : { ...(await startGatedRead(scope)), writer: undefined };
    let readSettled = false;
    const markSettled = () => {
      readSettled = true;
    };
    void reading.then(markSettled, markSettled);
    let closed = false;
    const closing = (
      ending === "release" ? claim.release() : closeDatabase(database.path, database.agentId)
    ).then(() => {
      expect(readSettled).toBe(true);
      closed = true;
    });
    try {
      if (phase === "queue") {
        // Queued cancellation must settle while the unrelated writer still holds FIFO.
        await expect(withinTest(reading, signal)).rejects.toThrow(revoked);
      }
      await expect(reader.withRead(requestFor(scope), noop, consume)).rejects.toThrow(revoked);
      if (phase === "reply") {
        expect(closed).toBe(false);
      }
      gate.release.resolve();
      await expect(withinTest(reading, signal)).rejects.toThrow(revoked);
      if (writer) {
        await withinTest(writer, signal);
      }
      await withinTest(closing, signal);
      expect(closed).toBe(true);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      gate.release.resolve();
      await Promise.allSettled([closing]);
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
  seed(scope, { sessionId: "healthy", updatedAt: 1 });
  seed({ ...scope, sessionKey: folded }, { sessionId: "broken", updatedAt: 1 });
  expect(loadExact(scope)?.entry.sessionId).toBe("healthy");
  const database = openOpenClawAgentDatabase(scope);
  const { reader } = await admitCohort(scope);
  const read = () =>
    reader.withRead(requestFor(scope), noop, (cohort) =>
      cohort.entries.map(({ sessionKey, entry }) => ({ sessionKey, sessionId: entry.sessionId })),
    );
  await expect(read()).resolves.toEqual([{ sessionKey: scope.sessionKey, sessionId: "healthy" }]);
  const foreign = openNodeSqliteDatabase(database.path);
  try {
    foreign
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run("{", folded);
  } finally {
    foreign.close();
  }
  // The selected row is unchanged; this phase must still refuse its corrupted folded guard.
  await expect(read()).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
  await expect(Promise.resolve().then(() => loadSessionEntry(scope))).rejects.toMatchObject({
    code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
  });
  await expect(readEntry(scope, noop)).rejects.toMatchObject({
    code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
  });
});
