import path from "node:path";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { assert, expect, it as baseIt, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { prepareSessionCostUsageRefreshLock } from "../../infra/session-cost-usage-cache.sqlite.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  drainGlobalSingletonLifecycleState,
  readGlobalSingleton,
} from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "./restart-recovery-receipt.js";
import { createSessionEntryWithTranscript } from "./session-accessor.entry-mutation.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import {
  consumeSessionPendingInput,
  readSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type {
  SessionActorHotState,
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorReceipt,
} from "./session-actor-contract.js";
import { hydrateSessionActorState } from "./session-actor-hydration.worker.js";
import {
  createSessionActorReplica,
  readSessionActorEntryFacts,
  readSessionActorRowFacts,
  readSessionActorTranscriptReplica,
  retainSessionActorEntryFacts,
  retainSessionActorTranscriptReplica,
} from "./session-actor-replica.js";
import type { SessionActorTranscriptReplica } from "./session-actor-transcript-replica.js";
import { sessionActorFileTarget } from "./session-actor-worker.test-support.js";
import { createSessionActor } from "./session-actor.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import type { PendingInputMutation } from "./session-pending-input-operations.types.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

type Fixture = Parameters<Parameters<typeof withReplica>[0]>[0];
type Replica = ReturnType<typeof replicaFor>;
const lifetime = { assertCurrent() {}, assertReadable() {} };
const entry = (label = "before", updatedAt = 1, sessionId = "replica-session") => ({
  sessionId,
  updatedAt,
  label,
});

function replicaFor(
  target: Parameters<typeof createSessionActorReplica>[0]["target"],
  currentGeneration: () => string,
) {
  const replica = createSessionActorReplica({ target, lifetime, currentGeneration });
  return Object.assign(replica, { [Symbol.dispose]: () => replica.close() });
}

function tokenFor(state: SessionActorHotState, databasePath: string) {
  return readSqliteDatabaseScopedWriteTokenForPath(databasePath, [
    ...collectSessionEntryLookupKeys(state.target.sessionKey),
    ...state.dependencySessionIds.map(sqliteSessionIdWriteScope),
  ])!;
}

function retainEntry(
  state: SessionActorHotState,
  facts: Parameters<typeof retainSessionActorEntryFacts>[1][number]["facts"],
  generation: string,
) {
  assert(state.target.database.kind === "file", "Replica fixture requires a durable target");
  retainSessionActorEntryFacts(
    state.target.database,
    [{ sessionKey: state.target.sessionKey, facts }],
    generation,
  );
}

function retainText(state: SessionActorHotState, text: string) {
  const transcript: SessionActorTranscriptReplica = {
    sessionId: state.entry?.sessionId,
    version: state.transcript.version,
    tail: {
      coveredAfterSeq: -1,
      events: [{ rawSeq: 0, event: { text }, serializedBytes: text.length }],
    },
  };
  retainSessionActorTranscriptReplica(state, transcript);
  return transcript;
}

async function withReplica(
  run: (fixture: {
    replica: Replica;
    database: ReturnType<typeof openOpenClawAgentDatabase>;
    scope: { agentId: string; sessionKey: string; storePath: string; env: NodeJS.ProcessEnv };
    load: (epoch?: string, sequence?: number) => SessionActorHotState;
    reacquire: () => Replica;
    retireGeneration: () => void;
  }) => void | Promise<void>,
  sessionKey = "agent:main:actor-replica",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = { agentId: "main", sessionKey, storePath: database.path, env };
    replaceSessionEntrySync(scope, entry());
    const identity = readOpenClawAgentDatabaseIdentity(database);
    assert(typeof identity.identity === "string", "Replica fixture requires a durable database");
    const target = sessionActorFileTarget(database, scope.sessionKey);
    let generation = 0;
    const reacquire = () => replicaFor(target, () => `${identity.incarnation}:${generation}`);
    using replica = reacquire();
    const load = (epoch = "first", sequence = 0): SessionActorHotState => {
      const writeToken = readSqliteDatabaseScopedWriteTokenForPath(
        database.path,
        collectSessionEntryLookupKeys(target.sessionKey),
      );
      assert(writeToken, "Replica fixture has an unsettled native writer");
      const state = hydrateSessionActorState(database, target, { epoch, sequence }, writeToken).hot;
      state.writeToken = tokenFor(state, database.path);
      return state;
    };
    await run({
      replica,
      database,
      scope,
      load,
      reacquire,
      retireGeneration() {
        generation += 1;
      },
    });
  });
}

const it = baseIt.extend<{ fixture: Fixture }>({
  fixture: async ({ task: _task }, use) => withReplica(use),
});

function hydrate({ replica, load }: Fixture, epoch = "first", sequence = 0) {
  const selected = replica.beginRead();
  const snapshot = load(epoch, sequence);
  expect(selected(snapshot)).toBe(true);
  return snapshot;
}

function reloadInvalidated(fixture: Fixture) {
  expect(fixture.replica.read()).toBeUndefined();
  return hydrate(fixture);
}

it("preserves byte charges for shared rows, nested payloads, and each context form", ({
  fixture,
}) => {
  const state = hydrate(fixture);
  const pool = readGlobalSingleton(Symbol.for("openclaw.sessionActorReplicas"));
  assert(pool && typeof pool === "object" && "bytes" in pool && typeof pool.bytes === "number");
  const initialBytes = pool.bytes;
  const row = {
    rawSeq: 0,
    serializedBytes: 100,
    event: {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "toolCall", arguments: { paths: ["a", "b"], options: { recursive: true } } },
        ],
      },
    },
  };
  const version = { generation: "g", rawSeq: 0, updatedAt: 1 };
  const limits = { maxBytes: 4096, maxEvents: 8 };
  const cases: [SessionActorTranscriptReplica["context"], number][] = [
    [undefined, 1426],
    [{ limits, rows: [row], activeLeafEntryId: null }, 2722],
    [
      {
        limits,
        window: {
          header: row,
          rows: [row],
          activeLeafEntryId: null,
          totalEvents: 1,
          earliestFence: 0,
          truncatedPrefix: true,
          preceding: { rawSeq: -1, serializedBytes: 20 },
        },
      },
      4078,
    ],
    [
      {
        limits,
        exact: {
          kind: "bounded",
          snapshot: {
            version,
            activeLeafEntryId: null,
            opaqueParents: new Map(),
            parents: new Map(),
            firstKeptRanges: new Map(),
            persistedSuffixStartSeq: 0,
            boundaryCount: 0,
            events: [row.event],
            serializedBytes: 100,
            totalEvents: 1,
            transcriptMutationAt: 1,
            truncated: true,
          },
        },
      },
      3488,
    ],
  ];
  for (const [context, expectedBytes] of cases) {
    const transcript: SessionActorTranscriptReplica = {
      sessionId: "s",
      version,
      tail: { coveredAfterSeq: -1, events: [row] },
      ...(context ? { context } : {}),
    };
    // The same row is charged at every occurrence, even when its size is memoized.
    for (let repeat = 0; repeat < 2; repeat++) {
      retainSessionActorTranscriptReplica(state, transcript);
      expect(pool.bytes).toBe(initialBytes + expectedBytes);
    }
    retainSessionActorTranscriptReplica(state, {
      ...transcript,
      tail: { ...transcript.tail, events: [row, { ...row, rawSeq: 1 }] },
    });
    expect(pool.bytes).toBe(initialBytes + expectedBytes + 978);
  }
});

it("keeps transcript replacement charges within the shared byte and entry budgets", async () => {
  await drainGlobalSingletonLifecycleState("restart");
  await withReplica((fixture) => {
    const original = fixture.load();
    fixture.replica.close();
    fixture.replica.invalidate();
    const cells: Array<{ replica: Replica; state: SessionActorHotState }> = [];
    const create = (entryFirst = false, keepOpen = false) => {
      const state: SessionActorHotState = {
        ...structuredClone(original),
        target: { ...original.target, sessionKey: `agent:main:budget-${cells.length}` },
      };
      state.dependencySessionIds = [];
      state.writeToken = tokenFor(state, fixture.database.path);
      if (entryFirst) {
        retainEntry(state, { entry: state.entry, snapshots: "full" }, "budget-reader");
      }
      const replica = replicaFor(
        sessionActorFileTarget(fixture.database, state.target.sessionKey),
        () => "budget-reader",
      );
      expect(replica.beginRead()(state)).toBe(true);
      if (!keepOpen) {
        replica.close();
      }
      const cell = { replica, state };
      cells.push(cell);
      return cell;
    };
    const retain = (cell: (typeof cells)[number], characters: number) =>
      retainText(cell.state, "x".repeat(characters));
    try {
      const first = create(false, true);
      const second = create(true);
      const third = create();
      const firstTranscript = retain(first, 1024 * 1024);
      retain(second, 1024 * 1024);
      const thirdTranscript = retain(third, 1024 * 1024);
      // A copy-on-write append charges shared payloads again and evicts the next oldest.
      const grown: SessionActorTranscriptReplica = {
        ...firstTranscript,
        tail: {
          ...firstTranscript.tail,
          events: [
            ...firstTranscript.tail.events,
            { ...firstTranscript.tail.events[0]!, rawSeq: 1 },
          ],
        },
      };
      retainSessionActorTranscriptReplica(first.state, grown);
      expect(readSessionActorTranscriptReplica(second.state)).toBeUndefined();
      expect(readSessionActorTranscriptReplica(third.state)).toBe(thirdTranscript);
      expect(readSessionActorTranscriptReplica(first.state)).toBe(grown);
      retain(first, 512 * 1024);
      first.replica.invalidate();
      expect(first.replica.beginRead()(first.state)).toBe(true);
      retain(first, 1024 * 1024);
      const fourth = create();
      retain(fourth, 2 * 1024 * 1024);
      expect(readSessionActorTranscriptReplica(third.state)).toBeUndefined();
      expect(readSessionActorTranscriptReplica(first.state)).toBeDefined();
      const oversized = retain(fourth, 5 * 1024 * 1024);
      expect(readSessionActorTranscriptReplica(first.state)).toBeUndefined();
      expect(readSessionActorTranscriptReplica(fourth.state)).toBe(oversized);
      retain(fourth, 16);
      for (const cell of cells) {
        cell.replica.close();
        cell.replica.invalidate();
      }
      const small = Array.from({ length: 129 }, (_, index) => {
        const cell = create(index % 2 === 0, true);
        return { cell, transcript: retain(cell, 16) };
      });
      expect(readSessionActorTranscriptReplica(small[0]!.cell.state)).toBeUndefined();
      for (const { cell, transcript } of small.slice(1)) {
        expect(readSessionActorTranscriptReplica(cell.state)).toBe(transcript);
      }
    } finally {
      for (const { replica } of cells) {
        replica.close();
        replica.invalidate();
      }
    }
  });
});

it.each(["entry", "transcript", "plugin keys"] as const)(
  "evicts old replicas for large %s strings and releases replaced bytes",
  async (payload) => {
    await withReplica(({ replica, load }) => {
      const first = load();
      assert(first.target.database.kind === "file", "Replica fixture requires a durable target");
      const database = first.target.database;
      const siblingTarget = {
        database,
        sessionKey: "agent:main:budget-sibling",
      };
      using sibling = replicaFor(siblingTarget, () => "budget-sibling");
      const large = "x".repeat(5 * 1024 * 1024);
      const install = (label: string) => {
        const next = load();
        if (payload !== "transcript") {
          next.entry = entry(label);
          if (payload === "plugin keys") {
            next.entry.label = "before";
            next.entry.pluginExtensions = { fixture: { [label]: null } };
          }
        }
        expect(replica.beginRead()(next)).toBe(true);
        if (payload === "transcript") {
          retainText(next, label);
        }
        return next;
      };
      const installSibling = () => {
        const next = { ...load(), target: siblingTarget };
        next.writeToken = tokenFor(next, database.nativeLocation);
        expect(sibling.beginRead()(next)).toBe(true);
        return next;
      };
      const oversized = install(large);
      expect(replica.read()).toBe(oversized);
      const small = installSibling();
      expect(replica.read()).toBeUndefined();
      expect(sibling.read()).toBe(small);
      install(large);
      expect(sibling.read()).toBeUndefined();
      const replaced = install("small");
      installSibling();
      expect(replica.read()).toBe(replaced);
    });
  },
);

it("keeps actor facts after usage cache writes and pruning", async ({ fixture }) => {
  const { database, scope, replica } = fixture;
  const usage = prepareSessionCostUsageRefreshLock(scope.agentId, database.path, {
    env: scope.env,
  });
  try {
    expect(await usage.acquire()).toBe(true);
    const snapshot = hydrate(fixture);
    const valueJson = new TextEncoder().encode("{}");
    await usage.writeRollup([{ rollupId: "usage-rollup", valueJson, blob: null, updatedAt: 1 }]);
    expect(replica.read()).toEqual(snapshot);
    await usage.pruneRows([{ key: "usage-rollup", valueJson, updatedAt: 1 }]);
    expect(replica.read()).toEqual(snapshot);
  } finally {
    await usage.release();
  }
});

it("retains the first creation after restart before any replica reader and applies later writes", async () => {
  await drainGlobalSingletonLifecycleState("restart");
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:first-reader";
    const createdScope = { agentId: "main", sessionKey, storePath: database.path, env };
    const created = await createSessionEntryWithTranscript(createdScope, () => ({
      ok: true,
      entry: { sessionId: "first-reader-session", updatedAt: 1, label: "created" },
    }));
    expect(created.ok).toBe(true);
    const durableTarget = sessionActorFileTarget(database, sessionKey);
    expect(readSessionActorEntryFacts(durableTarget)?.entry).toMatchObject({ label: "created" });
    await patchSessionEntryCore(createdScope, () => ({ updatedAt: 2, label: "updated" }));
    expect(readSessionActorEntryFacts(durableTarget)?.entry).toMatchObject({ label: "updated" });
    runOpenClawAgentWriteTransaction((current) => deleteSessionEntryRows(current, sessionKey), {
      agentId: createdScope.agentId,
      path: database.path,
      env,
    });
    expect(readSessionActorEntryFacts(durableTarget)).toBeUndefined();
  });
});

function command(snapshot: SessionActorHotState, commandId: string) {
  return {
    commandId,
    phaseId: "turn",
    phase: "patch" as const,
    expected: snapshot.version,
  };
}

function committed(
  context: ReturnType<typeof command>,
  postimage: SessionActorHotState,
): Extract<SessionActorOutcome<undefined>, { kind: "committed" }> {
  const receipt: SessionActorReceipt = {
    kind: "session-actor-committed",
    commandId: context.commandId,
    phaseId: context.phaseId,
    phase: context.phase,
    beforeVersion: context.expected,
    afterVersion: postimage.version,
    transcript: {
      before: postimage.transcript.version,
      after: postimage.transcript.version,
      appendedMessages: [],
      projectionNeedsReconcile: false,
    },
    reducers: [],
    postimage,
  };
  return { kind: "committed", value: undefined, receipt };
}

it("returns a newer committed replica when a receipt arrives during a worker read", async ({
  fixture: { replica, load, scope },
}) => {
  const initial = load();
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<SessionActorHotState>();
  const execute = vi
    .fn<SqliteWorkerStore<SessionActorOperations>["execute"]>()
    .mockReturnValue(reply.promise);
  const actor = createSessionActor({
    target: initial.target,
    lifetime,
    replica,
    transport: {
      run: async (operation) => {
        const result = operation({ execute });
        started.resolve();
        return result;
      },
      async release() {},
    },
  });
  const authorize = vi.fn();
  try {
    const reading = actor.read({ assertCurrent() {}, authorize });
    await started.promise;
    const pending = replica.beginCommand();
    replaceSessionEntrySync(scope, entry("after", 2));
    expect(pending.settle(committed(command(initial, "newer"), load("first", 1)))).toBe(true);
    reply.resolve(initial);
    expect((await reading).entry).toMatchObject({ updatedAt: 2, label: "after" });
    expect(execute).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenLastCalledWith(
      "commit",
      expect.objectContaining({ entry: expect.objectContaining({ updatedAt: 2 }) }),
    );
  } finally {
    reply.resolve(initial);
    await actor.release();
  }
});

it("shares committed facts across released handles and retires them for writes and worker loss", async () => {
  await withReplica((fixture) => {
    hydrate(fixture);
    const change = { ...fixture.scope, sessionKey: fixture.scope.sessionKey.toLowerCase() };
    sessionChanges.invalidate({ ...change, factsInvalidated: true });
    expect(fixture.replica.read()).toBeUndefined();
    hydrate(fixture);
    sessionChanges.invalidate({ all: true, scope: { storePath: change.storePath } });
    expect(fixture.replica.read()).toBeUndefined();
    const first = hydrate(fixture);
    using replacement = fixture.reacquire();
    fixture.replica.close();
    expect(fixture.replica.read()).toBeUndefined();
    expect(replacement.read()).toEqual(first);
    const context = command(first, "replacement-command");
    const pending = replacement.beginCommand();
    using sibling = fixture.reacquire();
    expect(sibling.read()).toEqual(first);
    expect(pending.settle(committed(context, fixture.load("first", 1)))).toBe(true);
    expect(sibling.read()?.version).toEqual({ epoch: "first", sequence: 1 });
    replacement.close();
    expect(sibling.read()?.version.sequence).toBe(1);
    assignSessionOwner(fixture.scope, {
      owner: { type: "agent", id: "new-owner" },
      assignedBy: { type: "agent", id: "main" },
      assignedAt: 2,
    });
    expect(sibling.read()).toBeUndefined();
    hydrate({ ...fixture, replica: sibling }, "after-write");
    expect(sibling.read()?.entry?.owner?.actor.id).toBe("new-owner");
    fixture.retireGeneration();
    using restarted = fixture.reacquire();
    expect(restarted.read()).toBeUndefined();
    expect(sibling.read()).toBeUndefined();
    hydrate({ ...fixture, replica: restarted }, "restarted");
    expect(restarted.read()?.version.epoch).toBe("restarted");
  }, "agent:main:matrix:group:!Room:server");
});

it("retains unrelated session postimages but invalidates a shared physical session window", ({
  fixture,
}) => {
  const other = { ...fixture.scope, sessionKey: "agent:main:other-replica" };
  replaceSessionEntrySync(other, entry("other", 1, "other-session"));
  const snapshot = hydrate(fixture);
  retainEntry(snapshot, { entry: snapshot.entry, snapshots: [] }, "partial-entry-reader");
  expect(fixture.replica.read()).toEqual(snapshot);
  replaceSessionEntrySync(other, entry("changed", 2, "other-session"));
  expect(fixture.replica.read()).toEqual(snapshot);
  using sibling = openNodeSqliteDatabase(fixture.database.path);
  withSqliteDatabaseWriteScope(
    sibling,
    [other.sessionKey, sqliteSessionIdWriteScope("other-session")],
    () =>
      runSqliteImmediateTransactionSync(sibling, () => {
        sibling
          .prepare("UPDATE session_windows SET display_name = ? WHERE session_id = ?")
          .run("sibling-window", "other-session");
      }),
  );
  expect(fixture.replica.read()).toEqual(snapshot);

  // A second logical key can point at the actor's existing physical window.
  replaceSessionEntrySync(other, entry("shared", 3));
  expect(fixture.replica.read()).toBeUndefined();
  expect(
    fixture.database.db
      .prepare("SELECT display_name FROM session_windows WHERE session_id = ?")
      .get("replica-session"),
  ).toEqual({ display_name: "shared" });
  expect(hydrate(fixture).entry?.label).toBe("before");
  const shared = fixture.replica.read();
  assignSessionOwner(other, {
    owner: { type: "agent", id: "other-owner" },
    assignedBy: { type: "agent", id: "main" },
    assignedAt: 4,
  });
  // Ownership belongs to the other logical row, not its shared window.
  expect(fixture.replica.read()).toEqual(shared);
});

it("invalidates partial native publications before disclosure and count-only participant writes through the shared receipt", ({
  fixture,
}) => {
  const { replica, scope, database, load } = fixture;
  hydrate(fixture);
  const disclosures: Array<SessionActorHotState | undefined> = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      disclosures.push(replica.read());
    }
  });
  try {
    addSessionMember(scope, { identityId: "reader", addedBy: "owner", addedAt: 2 });
    expect(disclosures.length).toBeGreaterThan(0);
    expect(disclosures.every((value) => value === undefined)).toBe(true);
    expect(reloadInvalidated(fixture).members).toEqual([
      { identityId: "reader", addedBy: "owner", addedAt: 2 },
    ]);

    const participant = {
      identity: { type: "agent" as const, id: "helper" },
      sessionAgentId: "main",
    };
    recordSessionParticipant(scope, { ...participant, promptedAt: 3 });
    hydrate(fixture);
    expect(replica.read()?.participants[0]?.contributionCount).toBe(1);
    recordSessionParticipant(scope, { ...participant, promptedAt: 4 });
    // This writer intentionally omits a display delta for contribution-only changes.
    expect(reloadInvalidated(fixture).participants[0]).toMatchObject({
      contributionCount: 2,
      lastPromptedAt: 4,
    });

    expect(() =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          writeSessionEntry(current, scope.sessionKey, entry("rolled back", 5));
          throw new Error("abort replica fixture");
        },
        { agentId: scope.agentId, path: database.path, env: scope.env },
      ),
    ).toThrow("abort replica fixture");
    expect(load().entry?.label).toBe("before");
    expect(hydrate(fixture).entry?.label).toBe("before");
  } finally {
    unsubscribe();
  }
});

it("invalidates unaccounted native writes and retains accepted postimages across handle closure", ({
  fixture,
}) => {
  const { replica, load, scope, database } = fixture;
  const initial = hydrate(fixture);
  const shared = replica.read()!;
  expect(shared).toBe(initial);
  expect(replica.read()).toBe(shared);
  expect(replica.beginRead()(shared)).toBe(true);
  expect(replica.read()).toBe(shared);

  const accepted = command(initial, "accepted");
  const pending = replica.beginCommand();
  expect(replica.read()).toBe(shared);
  const rowTarget = { path: database.path, sessionKey: scope.sessionKey };
  expect(readSessionActorRowFacts(rowTarget)).toMatchObject({
    entry: { sessionId: "replica-session", updatedAt: 1, label: "before" },
    hasBoard: false,
  });
  withSqliteDatabaseWriteScope(database.db, [scope.sessionKey], () =>
    runSqliteImmediateTransactionSync(database.db, () => {
      database.db
        .prepare("UPDATE session_nodes SET updated_at = ?, entry_json = ? WHERE session_key = ?")
        .run(2, JSON.stringify({ ...shared.entry, updatedAt: 2 }), scope.sessionKey);
    }),
  );
  expect(replica.read()).toBeUndefined();
  expect(readSessionActorRowFacts(rowTarget)).toBeUndefined();
  replaceSessionEntrySync(scope, {
    ...entry(),
    sessionStartedAt: 23,
    usageFamilySessionIds: [],
  });
  const outcome = committed(accepted, load("first", 1));
  expect(pending.settle(outcome)).toBe(true);
  expect(replica.read()).toBe(outcome.receipt.postimage);

  const opaque = load("opaque");
  opaque.entry!.swarmOutputSchema = { value: new Date(0) };
  expect(replica.beginRead()(opaque)).toBe(true);
  const borrowed = replica.read()!;
  expect(replica.beginRead()(borrowed)).toBe(true);
  expect(replica.read()).toBe(borrowed);
  expect(replica.read()?.entry?.swarmOutputSchema).toEqual({ value: new Date(0) });

  const current = hydrate(fixture, "final");
  const closingContext = command(current, "accepted-before-close");
  const closing = replica.beginCommand();
  replica.close();
  expect(closing.settle(committed(closingContext, load("final", 1)))).toBe(true);
  expect(replica.read()).toBeUndefined();
});

it("reuses list facts and invalidates summary watermarks after transcript writes", async () => {
  // Worker retirement revokes resident facts, so settle earlier fixtures before asserting reuse.
  await drainGlobalSingletonLifecycleState("restart");
  await withReplica(async (fixture) => {
    const { scope, replica } = fixture;
    replaceSessionEntrySync(scope, {
      sessionId: "replica-session",
      updatedAt: 1,
      skillsSnapshot: { prompt: "Saved instructions", skills: [] },
      activitySummary: {
        version: 1,
        text: "No messages yet",
        updatedAt: 1,
        sessionId: "replica-session",
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    });
    const before = hydrate(fixture);
    const target = { path: scope.storePath, sessionKey: scope.sessionKey };
    const facts = readSessionActorRowFacts(target);
    expect(before.entry?.skillsSnapshot?.prompt).toBe("Saved instructions");
    expect(facts?.entry).not.toHaveProperty("skillsSnapshot");
    expect(facts).toMatchObject({
      hasBoard: false,
      activitySummaryWatermark: { generation: null, maxSeq: null },
    });
    assert(facts, "Expected resident row facts");
    facts.entry.label = "caller edit";
    expect(readSessionActorRowFacts(target)?.entry.label).toBeUndefined();
    expect(facts.entry.activitySummary).toBe(before.entry?.activitySummary);
    expect(facts.activitySummaryWatermark).toBe(before.transcript.watermark);
    expect(() => {
      facts.entry.activitySummary!.text = "Caller edit to borrowed summary";
    }).toThrow(TypeError);
    expect(() => {
      facts.activitySummaryWatermark!.maxSeq = 99;
    }).toThrow(TypeError);

    assert(before.target.database.kind === "file", "Replica fixture requires a durable target");
    const entryTarget = { ...before.target, database: before.target.database };
    const projection = {
      hasBoard: before.hasBoard,
      activitySummaryWatermark: before.transcript.watermark,
    };
    expect(readSessionActorEntryFacts(entryTarget)?.projection).toEqual(projection);
    const readEntry = (fields?: Parameters<typeof readSessionActorEntryFacts>[1]) =>
      readSessionActorEntryFacts(entryTarget, fields);
    const metadata = readEntry([]);
    expect(metadata?.snapshots).toEqual([]);
    expect(metadata?.entry).not.toHaveProperty("skillsSnapshot");
    const selected = readEntry(["skillsSnapshot"]);
    expect(selected?.snapshots).toEqual(["skillsSnapshot"]);
    expect(selected?.entry?.skillsSnapshot?.prompt).toBe("Saved instructions");
    expect(selected?.entry?.skillsSnapshot).toBe(before.entry?.skillsSnapshot);
    expect(() => {
      selected!.entry!.skillsSnapshot!.prompt = "Caller edit";
    }).toThrow(TypeError);
    expect(readEntry()?.entry?.skillsSnapshot?.prompt).toBe("Saved instructions");
    replica.invalidate();
    const retainedEntry = { ...before.entry!, skillsSnapshot: undefined };
    retainEntry(before, { entry: retainedEntry, snapshots: [], projection }, "row-facts-reader");
    const retained = readEntry()!;
    expect(retained.entry).toBe(retainedEntry);
    expect(retained.projection).toBe(projection);
    expect(retained.entry?.label).toBeUndefined();
    expect(retained.projection?.hasBoard).toBe(false);
    expect(readEntry()?.entry).toBe(retained.entry);
    expect(() => {
      retained.entry!.label = "Caller edit after reading";
    }).toThrow(TypeError);
    expect(() => {
      retained.projection!.hasBoard = true;
    }).toThrow(TypeError);
    expect(readEntry()?.entry?.label).toBeUndefined();
    expect(readEntry()?.projection?.hasBoard).toBe(false);
    expect(readEntry(["skillsSnapshot"])?.snapshots).toEqual([]);
    const retainedRow = readSessionActorRowFacts(target)!;
    expect(retainedRow.entry.activitySummary).toBe(retained.entry?.activitySummary);
    expect(retainedRow.activitySummaryWatermark).toBe(before.transcript.watermark);
    expect((await readSessionEntryReadOnlyInWorker(scope))?.skillsSnapshot?.prompt).toBe(
      "Saved instructions",
    );

    const appended = appendTranscriptEventSync(
      { ...scope, sessionId: "replica-session" },
      { type: "proof", id: "summary-watermark" },
    );
    expect(appended.ok).toBe(true);
    expect(readSessionActorRowFacts(target)).toBeUndefined();
    const after = hydrate(fixture);
    expect(after.transcript.watermark).not.toEqual(before.transcript.watermark);
    expect(readSessionActorRowFacts(target)?.activitySummaryWatermark).toEqual(
      after.transcript.watermark,
    );
  });
});

it("invalidates pending custody for staging, promotion, terminal completion and withdrawal", ({
  fixture,
}) => {
  const { scope, database } = fixture;
  const options = { agentId: scope.agentId, path: database.path, env: scope.env };
  const mutate = (input: PendingInputMutation) =>
    mutatePendingInput(
      input,
      {
        admit() {},
        writeTransaction: (operationLabel, _owner, write) =>
          runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
      },
      () => {},
    );
  const stage = (id: string) => {
    const identity = {
      sessionKey: scope.sessionKey,
      sessionId: "replica-session",
      idempotencyKey: id,
      runId: `run-${id}`,
      requestHash: id,
      lifecycleGeneration: "lifecycle",
    };
    const expected = readPendingInput(database, {
      ...identity,
      kind: "stage",
      trackCompletion: true,
    });
    assert(expected.kind === "stage", "Expected a pending input staging snapshot");
    mutate({
      ...identity,
      kind: "stage",
      expected,
      trackCompletion: true,
      inputId: id,
      messageJson: JSON.stringify({ role: "user", content: id, timestamp: 1 }),
    });
    return identity;
  };

  hydrate(fixture);
  stage("promote");
  expect(reloadInvalidated(fixture).pendingInputs).toMatchObject([
    { input_id: "promote", state: "queued" },
  ]);
  runOpenClawAgentWriteTransaction(
    (current) =>
      consumeSessionPendingInput(current, {
        inputId: "promote",
        message: { role: "user", content: "promote", timestamp: 1 },
        alreadyPromoted: false,
      }),
    options,
  );
  expect(reloadInvalidated(fixture).pendingInputs).toEqual([]);

  const complete = stage("complete");
  hydrate(fixture);
  mutate({ ...complete, kind: "complete", outcome: { reason: "completed", status: "ok" } });
  expect(reloadInvalidated(fixture).pendingInputs).toEqual([]);
  expect(readSessionInputCompletion(database, complete)?.outcome).toMatchObject({
    reason: "completed",
    status: "ok",
  });

  const withdraw = stage("withdraw");
  hydrate(fixture);
  mutate({ ...withdraw, kind: "finish", inputId: "withdraw", disposition: "cancelled" });
  expect(reloadInvalidated(fixture).pendingInputs).toMatchObject([
    { input_id: "withdraw", state: "cancelled" },
  ]);
});

it("retires hot facts across the released SDK and restart delivery owners", async ({ fixture }) => {
  const { scope } = fixture;
  replaceSessionEntrySync(scope, {
    ...fixture.load().entry!,
    restartRecoveryDeliveryRunId: "recovery-run",
    restartRecoveryDeliverySourceRunId: "source-run",
  });
  hydrate(fixture);
  await expect(
    patchSdkSessionEntry({
      ...scope,
      skipMaintenance: true,
      update: () => ({ label: "sdk label" }),
    }),
  ).resolves.toMatchObject({ label: "sdk label" });
  expect(reloadInvalidated(fixture).entry).toMatchObject({
    label: "sdk label",
    restartRecoveryDeliveryRunId: "recovery-run",
  });

  const delivery = {
    ...scope,
    sessionId: "replica-session",
    sourceTurnId: "source-run",
    toolCallId: "synthetic-delivery",
  };
  await expect(beginRestartRecoveryTerminalDelivery(delivery)).resolves.toBe("started");
  expect(reloadInvalidated(fixture).entry?.restartRecoveryDeliveryReceiptState).toBe(
    "terminal-pending",
  );
  await expect(completeRestartRecoveryTerminalDelivery(delivery)).resolves.toBe("recorded");
  expect(reloadInvalidated(fixture).entry?.restartRecoveryDeliveryReceiptState).toBe(
    "delivered-terminal",
  );
});

it("retires a resident session when native maintenance archives it", async ({ fixture }) => {
  const { scope, database } = fixture;
  const preservation = await prepareSessionMaintenancePreservation(scope.storePath);
  try {
    hydrate(fixture);
    const result = runOpenClawAgentWriteTransaction(
      (current) =>
        applySessionEntryMaintenance(current, {
          storePath: scope.storePath,
          archiveDirectory: path.join(path.dirname(scope.storePath), "archives"),
          forceMaintenance: true,
          preservation: preservation.capture,
          maintenanceConfig: {
            ...resolveMaintenanceConfigFromInput(),
            mode: "enforce",
            pruneAfterMs: 1,
            archiveDashboardAfterMs: null,
            preserveRecentMs: null,
          },
        }),
      { agentId: scope.agentId, path: database.path, env: scope.env },
    );
    expect(result.archived).toBe(1);
    expect(reloadInvalidated(fixture).entry).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "age-retention",
    });
  } finally {
    preservation.dispose();
  }
});
