import { AsyncLocalStorage } from "node:async_hooks";
import { deserialize, serialize } from "node:v8";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { patchSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { readConversation, registerConversationAddresses } from "./conversation-registry.js";
import { resolveConversationRouteFingerprint } from "./conversation-route-fingerprint.js";
import { resolveSessionLifecycleTimestampsAsync } from "./lifecycle-read.js";
import { retainPreparedSessionGenerationFacts } from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  readUnchangedLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  patchSessionEntryCore as patchInternalSessionEntry,
  applySessionEntryOperation,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { createSessionEntryPatchFixture as fixture } from "./session-entry-patch.test-support.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "./session-transcript-index.js";
import * as reconcile from "./session-transcript-reconcile.js";
import type { SessionEntry } from "./types.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const delivery = vi.hoisted(() => ({
  afterPrepare: undefined as (() => void) | undefined,
  afterCommit: undefined as (() => void) | undefined,
  beforeCommit: undefined as (() => void) | undefined,
  commands: [] as string[],
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  delivery.commands.push(command.type);
                  if (command.type === "session.entry.patch.commit") {
                    delivery.beforeCommit?.();
                  }
                  const result = await worker.execute(command, commandOptions);
                  if (command.type === "session.entry.patch.prepare") {
                    delivery.afterPrepare?.();
                  }
                  if (command.type === "session.entry.patch.commit") {
                    delivery.afterCommit?.();
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.afterPrepare = undefined;
  delivery.afterCommit = undefined;
  delivery.beforeCommit = undefined;
  delivery.commands = [];
  vi.restoreAllMocks();
});

function patchSessionEntryCore(
  ...[scope, update, options]: Parameters<typeof patchInternalSessionEntry>
) {
  return patchInternalSessionEntry(scope, update, { workerGuard: {}, ...options });
}

it("ends an absent live-switch selection without committing and keeps newer flags and callback CAS", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const initial = f.read()!;
    const newer = { ...initial, liveModelSwitchPending: true, modelOverride: "new-selection" };
    const update = vi.fn(() => ({ liveModelSwitchPending: undefined }));
    const onCommitted = vi.fn();
    const options = {
      skipMaintenance: true,
      prepareIf: { kind: "live-model-switch-pending" as const },
      onCommitted,
    };
    delivery.afterPrepare = () => {
      delivery.afterPrepare = undefined;
      replaceSessionEntrySync(f.scope, newer);
    };

    await expect(patchSessionEntryCore(f.scope, update, options)).resolves.toBeNull();
    expect(delivery.commands).toEqual(["session.entry.patch.prepare"]);
    expect(update).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(f.read()).toMatchObject(newer);

    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(f.scope, { ...newer, modelOverride: "latest-selection" });
    };
    await expect(patchSessionEntryCore(f.scope, update, options)).rejects.toBeInstanceOf(
      SqliteSessionMutationConflictError,
    );
    expect(update).toHaveBeenCalledOnce();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(f.read()).toMatchObject({
      liveModelSwitchPending: true,
      modelOverride: "latest-selection",
    });
  });
});

it("reduces a fixed patch against the current row in one worker request without losing foreign metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const original = f.read()!;
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(f.scope, { ...original, compactionCount: 4, label: "foreign edit" });
    };
    const published: SessionEntry[] = [];
    const result = await applySessionEntryOperation(
      f.scope,
      {
        kind: "compaction-accounting",
        expected: {
          sessionId: original.sessionId,
          lifecycleRevision: original.lifecycleRevision,
          activeWriterRunId: original.activeWriterRunId,
        },
        accounting: { amount: 2, tokensAfter: 123 },
      },
      { skipMaintenance: true, onCommitted: (entry) => published.push(entry) },
    );
    expect(delivery.commands.length).toBeLessThanOrEqual(1);
    expect(result).toMatchObject({ compactionCount: 6, totalTokens: 123, label: "foreign edit" });
    expect(f.read()).toEqual(result);
    expect(published).toEqual([result]);

    const current = f.read()!;
    for (const expected of [
      { sessionId: "retired" },
      { sessionId: current.sessionId, lifecycleRevision: "retired" },
      { sessionId: current.sessionId, activeWriterRunId: "retired" },
    ]) {
      const unchanged = await applySessionEntryOperation(
        f.scope,
        { kind: "compaction-accounting", expected, accounting: { amount: 10 } },
        { skipMaintenance: true, onCommitted: (entry) => published.push(entry) },
      );
      expect(unchanged).toEqual(current);
      expect(f.read()).toEqual(current);
    }
    expect(published).toEqual([result]);
  });
});

it("rechecks conversation authority before a fixed patch commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "patch-peer",
      deliveryTarget: "user:patch-peer",
    })!;
    await registerConversationAddresses(f.scope, [identity]);
    const conversation = (await readConversation(f.scope, identity.conversationRef))!;
    const workerGuard = {
      conversation: {
        conversationRef: identity.conversationRef,
        expectedRouteFingerprint: resolveConversationRouteFingerprint(conversation),
      },
    };
    const onCommitted = vi.fn();
    const accepted = await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "authorized" } },
      { skipMaintenance: true, workerGuard, onCommitted },
    );
    expect(accepted).toMatchObject({ label: "authorized" });
    expect(f.read()).toEqual(accepted);
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(accepted);
    onCommitted.mockClear();

    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      const foreign = new (requireNodeSqlite().DatabaseSync)(f.database.path);
      try {
        foreign
          .prepare("UPDATE conversations SET delivery_target = ? WHERE conversation_id = ?")
          .run("user:replacement", identity.conversationRef);
      } finally {
        foreign.close();
      }
    };
    await expect(
      applySessionEntryOperation(
        f.scope,
        { kind: "fields", patch: { label: "must not persist" } },
        { skipMaintenance: true, workerGuard, onCommitted },
      ),
    ).rejects.toThrow("Conversation is no longer available");
    expect(f.read()).toEqual(accepted);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await readConversation(f.scope, identity.conversationRef)).toMatchObject({
      target: "user:replacement",
    });
  });
});

it("skips unchanged cold serialization and preserves snapshot bytes and revisions on metadata patches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const cold = {
      sessionDiffBaseline: {
        version: 1,
        sessionId: "original",
        root: "/synthetic/workspace",
        files: Array.from({ length: 128 }, (_, index) => ({
          path: `src/fixture-${index}.ts`,
          fingerprint: "a".repeat(64),
        })),
      },
      skillsSnapshot: { prompt: "synthetic instructions ".repeat(4096), skills: [] },
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 100_000, projectContextChars: 0, nonProjectContextChars: 100_000 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 90_000, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    } satisfies Partial<SessionEntry>;
    replaceSessionEntrySync(f.scope, { sessionId: "original", updatedAt: 1, ...cold });
    const snapshots = () =>
      f.database.db
        .prepare(
          "SELECT field, value_json FROM session_entry_snapshots WHERE session_key = ? ORDER BY field",
        )
        .all(f.scope.sessionKey);
    const revision = () =>
      f.database.db
        .prepare("SELECT snapshot_revision FROM session_nodes WHERE session_key = ?")
        .get(f.scope.sessionKey)?.snapshot_revision;
    const saved = snapshots();
    const initialRevision = revision();
    const stringify = vi.spyOn(JSON, "stringify");
    const serializedColdFields = () =>
      stringify.mock.calls.filter(
        ([value]) =>
          value !== null &&
          typeof value === "object" &&
          ("prompt" in value || "files" in value || "systemPrompt" in value),
      ).length;
    // The native patch path executes this writer in-process, so this spy observes its JSON work.
    const patch = (update: Partial<SessionEntry>) =>
      patchInternalSessionEntry(f.scope, () => update, { skipMaintenance: true });
    await patch({ label: "metadata only" });
    expect(serializedColdFields()).toBe(0);
    expect(snapshots()).toEqual(saved);
    expect(revision()).toBe(initialRevision);
    expect(f.read()?.label).toBe("metadata only");

    stringify.mockClear();
    const changedSkills = { ...cold.skillsSnapshot, prompt: "changed instructions" };
    await patch({ skillsSnapshot: changedSkills });
    expect(serializedColdFields()).toBe(3);
    expect(snapshots()).toEqual(
      saved.map((row) =>
        row.field === "skillsSnapshot"
          ? { ...row, value_json: JSON.stringify(changedSkills) }
          : row,
      ),
    );
    expect(revision()).toBe(Number(initialRevision) + 1);

    stringify.mockClear();
    await patch({ skillsSnapshot: undefined });
    expect(serializedColdFields()).toBe(2);
    expect(snapshots()).toEqual(saved.filter((row) => row.field !== "skillsSnapshot"));
    expect(revision()).toBe(Number(initialRevision) + 2);
    await patch({ sessionDiffBaseline: undefined, systemPromptReport: undefined });
    expect(snapshots()).toEqual([]);
    expect(revision()).toBe(Number(initialRevision) + 4);
  });
});

it.each([false, true])(
  "evaluates the active-leaf predicate on the patch transaction's uncommitted transcript (dirty=%s)",
  async (dirty) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const options = { agentId: f.database.agentId, path: f.database.path };
      const scope = { ...f.scope, sessionId: "original" };
      const event = (id: string, parentId: string | null) => ({
        type: "message",
        id,
        parentId,
        message: { role: "user", content: id },
      });
      runOpenClawAgentWriteTransaction(
        (database) => appendTranscriptEventsInTransaction(database, scope, [event("root", null)]),
        options,
      );
      const prepared = readSessionEntrySelectionSnapshot(f.database, f.scope.sessionKey, false);
      const writeBase = prepared[0]!.entry;
      const { generation } = readSessionTranscriptWatermarkInDatabase(f.database, scope.sessionId);
      expect(generation).not.toBeNull();
      const observer = new (requireNodeSqlite().DatabaseSync)(f.database.path, { readOnly: true });
      const { port1, port2 } = new MessageChannel();
      try {
        admission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
          commitSessionEntryPatch(
            {
              selection: { kind: "entry", sessionKey: f.scope.sessionKey, exact: false },
              prepared,
              sessionKey: f.scope.sessionKey,
              writeBase,
              next: { ...writeBase, label: "transaction leaf accepted" },
              operationLabel: "session-entry.patch",
              validateCanonicalKeys: false,
              shouldCommitIf: {
                kind: "transcript",
                sessionId: scope.sessionId,
                generation,
                leafEntryId: "pending",
              },
            },
            {
              options,
              open: () => f.database,
              admit() {},
              writeTransaction: (operationLabel, _owner, write) =>
                runOpenClawAgentWriteTransaction(
                  (database) => {
                    appendTranscriptEventsInTransaction(database, scope, [
                      event("pending", "root"),
                    ]);
                    if (dirty) {
                      markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId);
                    }
                    expect(
                      observer
                        .prepare(
                          "SELECT leaf_event_id FROM session_transcript_index_state WHERE session_id = ?",
                        )
                        .get(scope.sessionId),
                    ).toMatchObject({ leaf_event_id: "root" });
                    return write(database);
                  },
                  options,
                  { operationLabel },
                ),
            },
          ),
        );
        expect(f.read()?.label).toBe(dirty ? "initial" : "transaction leaf accepted");
      } finally {
        observer.close();
        port1.close();
        port2.close();
      }
    });
  },
);

it("compares transported snapshot columns without rehydrating unchanged entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const snapshot: ReturnType<typeof readSessionEntrySelectionSnapshot> = deserialize(
      serialize(readSessionEntrySelectionSnapshot(f.database, f.scope.sessionKey, false)),
    );
    expect(readUnchangedLifecycleTargetSnapshot(f.database, snapshot)?.[0]?.entry.label).toBe(
      "initial",
    );
    replaceSessionEntrySync(f.scope, { sessionId: "original", updatedAt: 2, label: "changed" });
    expect(readUnchangedLifecycleTargetSnapshot(f.database, snapshot)).toBeUndefined();
  });
});

it("keeps updater context, FIFO and publication ordering while the host executes no session SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const context = new AsyncLocalStorage<string>();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const events: string[] = [];
    const stopRows = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === f.scope.sessionKey) {
        events.push("row");
      }
    });
    const stopIdentity = onSessionIdentityMutation((change) => {
      if (change.kind !== "delete" && change.current.sessionKeys.includes(f.scope.sessionKey)) {
        events.push(`identity:${change.current.sessionId}`);
      }
    });
    const sql = observeHostDataSql();
    const first = context.run("first", () =>
      patchSessionEntryCore(
        f.scope,
        async () => {
          events.push(`update:${context.getStore()}`);
          entered.resolve();
          await release.promise;
          return { sessionId: "first" };
        },
        { onCommitted: () => events.push(`commit:${context.getStore()}`) },
      ),
    );
    let second: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(entered.promise, first, "Patch ended before its updater");
      second = context.run("second", () =>
        patchSessionEntryCore(
          f.scope,
          (entry) => {
            events.push(`update:${context.getStore()}:${entry.sessionId}`);
            return { sessionId: "second" };
          },
          { onCommitted: () => events.push(`commit:${context.getStore()}`) },
        ),
      );
      expect(events).toEqual(["update:first"]);
      release.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual([
        "update:first",
        "row",
        "commit:first",
        "identity:first",
        "update:second:first",
        "row",
        "commit:second",
        "identity:second",
      ]);
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|\bCOMMIT\b|\bBEGIN IMMEDIATE\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      sql.restore();
      stopRows();
      stopIdentity();
    }
    expect(f.read()?.sessionId).toBe("second");
  });
});

it.each(["after updater", "final grant"] as const)(
  "rejects revoked host authority %s without committing",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      let current = true;
      const refusal = new Error("patch authority revoked");
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          createAdmission((request, grant) => {
            if (phase === "final grant" && request.stage === "commit") {
              current = false;
            }
            callback(request, grant);
          }, attachment),
      );
      const committed = vi.fn();
      await expect(
        patchSessionEntryCore(
          f.scope,
          async () => {
            if (phase === "after updater") {
              current = false;
            }
            return { label: "must not persist" };
          },
          {
            workerGuard: {
              assertCurrent() {
                if (!current) {
                  throw refusal;
                }
              },
            },
            onCommitted: committed,
          },
        ),
      ).rejects.toBe(refusal);
      expect(committed).not.toHaveBeenCalled();
      expect(f.read()?.label).toBe("initial");
    });
  },
);

it("settles false before CAS and later throwing authority, while null updates still validate CAS", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const sourceScope = { ...f.scope, sessionKey: "agent:main:patch-source" };
    const changeSource = (label: string) =>
      replaceSessionEntrySync(sourceScope, { sessionId: "source", updatedAt: 1, label });
    changeSource("original source");
    const identity = readOpenClawAgentDatabaseIdentity(f.database);
    const refusal = new Error("session source changed");
    const refuse = vi.fn((): never => {
      throw refusal;
    });
    const source: SessionSourceAssertion = Object.assign(() => {}, {
      async prepareSessionSource() {
        const expected = await readSessionEntryInWorker(sourceScope, () => {});
        const assertCurrent = () => {
          if (expected?.sessionId !== "source" || expected.label !== "original source") {
            refuse();
          }
        };
        assertCurrent();
        return {
          assertCurrent,
          checks: [
            {
              predicate: {
                source: {
                  agentId: f.database.agentId,
                  path: f.database.path,
                  databaseIdentity: identity.identity,
                  databaseBirthtime: identity.birthtime,
                },
                sessionKey: sourceScope.sessionKey,
                fields: ["label" as const],
                expected,
              },
              refuse,
            },
          ],
        };
      },
    });
    let current = true;
    let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) => {
        const owned = createAdmission((request, grant) => {
          if (request.stage === "transaction" || request.stage === "commit") {
            nativeAdmission = owned;
          }
          if (request.stage === "commit") {
            current = false;
          }
          callback(request, grant);
        }, attachment);
        return owned;
      },
    );
    const changeDuringUpdate = () => {
      changeSource("changed before false predicate");
      replaceSessionEntrySync(f.scope, { sessionId: "replacement", updatedAt: 2, label: "newer" });
      return null;
    };
    await expect
      .soft(
        patchSessionEntryCore(f.scope, changeDuringUpdate, {
          workerGuard: {
            source,
            assertCurrent() {
              if (!current) {
                throw new Error("too late");
              }
            },
            shouldCommitIf: {
              kind: "transcript",
              sessionId: "original",
              generation: "not-current",
              leafEntryId: null,
            },
          },
        }),
      )
      .resolves.toBeNull();
    expect(f.read()?.label).toBe("newer");
    expect.soft(refuse).not.toHaveBeenCalled();
    changeSource("original source");
    const conflict = patchSessionEntryCore(
      f.scope,
      () => {
        changeSource("changed before target conflict");
        replaceSessionEntrySync(f.scope, { sessionId: "another", updatedAt: 3 });
        return null;
      },
      { workerGuard: { source } },
    );
    await expect.soft(conflict).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
    await expect.soft(conflict).rejects.toThrow("state changed while preparing");
    expect.soft(refuse).not.toHaveBeenCalled();

    changeSource("original source");
    const before = f.read();
    const previousAdmission = nativeAdmission;
    await expect(
      patchSessionEntryCore(
        f.scope,
        () => {
          changeSource("changed before source guard");
          return { label: "must not persist" };
        },
        { workerGuard: { source } },
      ),
    ).rejects.toBe(refusal);
    expect.soft(refuse).toHaveBeenCalledOnce();
    expect(f.read()).toEqual(before);
    expect(nativeAdmission).toBeDefined();
    expect(nativeAdmission).not.toBe(previousAdmission);
    expect(nativeAdmission?.settlement).toMatchObject({ kind: "completed" });
    expect(nativeAdmission?.committed).toBeUndefined();
  });
});

it("recovers missing lifecycle timestamps during worker patch planning", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const startedAt = 1_700_000_000_000;
    runOpenClawAgentWriteTransaction(
      (database) =>
        appendTranscriptEventsInTransaction(database, { ...f.scope, sessionId: "original" }, [
          { type: "session", id: "original", version: 3, timestamp: startedAt },
        ]),
      { agentId: f.database.agentId, path: f.database.path },
    );
    const entry = await patchSessionEntryCore(f.scope, async (current) => {
      const timestamps = await resolveSessionLifecycleTimestampsAsync({
        ...f.scope,
        entry: current,
        signal,
      });
      return { sessionStartedAt: timestamps.sessionStartedAt };
    });
    expect(entry?.sessionStartedAt).toBe(startedAt);
    expect(f.read()?.sessionStartedAt).toBe(startedAt);
  });
});

it("retains nested worker admission for an opaque plugin updater", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const entry = await patchSessionEntry({
      ...f.scope,
      update: async () => {
        const read = await withinTest(
          readSessionEntryInWorker(f.scope, () => signal.throwIfAborted()),
          signal,
        );
        return { label: `${read?.label}:nested` };
      },
    });
    expect(entry?.label).toBe("initial:nested");
    expect(f.read()?.label).toBe("initial:nested");
  });
});

it("settles acknowledged entry publication when reconcile scheduling throws", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:acknowledged-publication",
      sessionId: "acknowledged-publication",
    };
    runOpenClawAgentWriteTransaction(
      (current) => {
        appendTranscriptEventsInTransaction(current, scope, [
          { type: "message", id: "seed", message: { role: "user", content: "seed" } },
        ]);
        markSessionTranscriptIndexDirtyInTransaction(current.db, scope.sessionId);
      },
      { agentId: scope.agentId, path: database.path },
    );
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected a durable publication fixture");
    }
    const retained = retainPreparedSessionGenerationFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey: scope.sessionKey,
      entry: undefined,
    });
    const identities: string[] = [];
    const stop = onSessionIdentityMutation((change) => {
      if (change.kind !== "delete" && change.current.sessionKeys.includes(scope.sessionKey)) {
        identities.push(change.kind);
      }
    });
    const failure = new Error("reconcile scheduling refused after COMMIT");
    const scheduling = vi
      .spyOn(reconcile, "startSessionTranscriptIndexReconcile")
      .mockImplementationOnce(() => {
        throw failure;
      });
    const committed = vi.fn();
    try {
      await expect(
        appendExpectedSessionTranscriptTurn(scope, {
          keyFormat: "agent-qualified",
          expectedSessionId: scope.sessionId,
          selectedSessionId: null,
          initialSessionEntry: { sessionId: scope.sessionId, updatedAt: 1 },
          sessionFile: "synthetic-session.jsonl",
          messages: [{ eventId: "committed", message: { role: "user", content: "committed" } }],
          onMessageCommitted: committed,
        }),
      ).rejects.toBe(failure);
      expect(scheduling).toHaveBeenCalledOnce();
      expect(
        readTranscriptEventRows(database, scope.sessionId).filter(
          (row) => JSON.parse(row.eventJson).id === "committed",
        ),
      ).toHaveLength(1);
      expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.sessionId).toBe(
        scope.sessionId,
      );
      expect(retained.prepareRead()).toBeUndefined();
      expect(retained.readCurrent()?.sessionId).toBe(scope.sessionId);
      expect(identities).toEqual(["create"]);
      expect(committed).toHaveBeenCalledOnce();
    } finally {
      stop();
      retained.release();
    }
  });
});

it.each(["lost reply", "callback failure", "unknown settlement with callback failure"] as const)(
  "publishes exactly once after COMMIT despite %s",
  async (fault) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const failure = new Error(fault);
      if (fault === "unknown settlement with callback failure") {
        let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
        const createAdmission = admission.createSqliteWorkerOperationAdmission;
        vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (callback, attachment) => {
            const owned = createAdmission((request, grant) => {
              if (request.stage === "commit") {
                nativeAdmission = owned;
              }
              callback(request, grant);
            }, attachment);
            return owned;
          },
        );
        delivery.afterCommit = () => {
          expect(nativeAdmission?.committed?.facts).toMatchObject({
            kind: "session-entry-patch-committed",
          });
          if (!nativeAdmission) {
            throw new Error("Patch did not reach native commit admission");
          }
          vi.spyOn(nativeAdmission, "settlement", "get").mockReturnValue({ kind: "unknown" });
        };
      }
      const order: string[] = [];
      const stop = onSessionIdentityMutation((change) => {
        if (change.kind !== "delete" && change.current.sessionId === "committed") {
          order.push("identity");
        }
      });
      if (fault === "lost reply") {
        delivery.afterCommit = () => {
          throw failure;
        };
      }
      const prompt = fault === "lost reply" ? "synthetic ".repeat(4 * 1024 * 1024) : undefined;
      const update = vi.fn(() => ({
        sessionId: "committed",
        label: undefined,
        ...(prompt ? { skillsSnapshot: { prompt, skills: [] } } : {}),
      }));
      try {
        const result = patchSessionEntryCore(f.scope, update, {
          onCommitted() {
            order.push("callback");
            if (fault !== "lost reply") {
              throw failure;
            }
          },
        });
        if (fault === "callback failure") {
          await expect(result).rejects.toBe(failure);
        } else if (fault === "unknown settlement with callback failure") {
          await expect(result).rejects.toMatchObject({ code: "outcome-unknown", cause: failure });
        } else {
          const entry = await result;
          expect(entry?.sessionId).toBe("committed");
          expect(entry?.skillsSnapshot?.prompt.length).toBe(prompt?.length);
          expect(entry?.label).toBeUndefined();
        }
        expect(update).toHaveBeenCalledOnce();
        expect(order).toEqual(["callback", "identity"]);
        expect(f.read()?.sessionId).toBe("committed");
      } finally {
        stop();
      }
    });
  },
);

it("preserves an unknown native outcome when releasing its prepared source also fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const replyFailure = new Error("commit reply lost");
    const cleanupFailure = new Error("prepared source release failed");
    let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) => {
        const owned = createAdmission((request, grant) => {
          if (request.stage === "commit") {
            nativeAdmission = owned;
          }
          callback(request, grant);
        }, attachment);
        return owned;
      },
    );
    const loseCommitResult = vi.fn(() => {
      expect(nativeAdmission?.committed?.facts).toMatchObject({
        kind: "session-entry-patch-committed",
      });
      if (!nativeAdmission) {
        throw new Error("Patch did not reach native commit admission");
      }
      // The real write has committed; neither reply nor native receipt reaches settlement.
      vi.spyOn(nativeAdmission, "committed", "get").mockReturnValue(undefined);
      vi.spyOn(nativeAdmission, "settlement", "get").mockReturnValue({ kind: "unknown" });
      throw replyFailure;
    });
    delivery.afterCommit = loseCommitResult;
    const releaseFirst = vi.fn();
    const releaseLast = vi.fn(() => {
      throw cleanupFailure;
    });
    const update = vi.fn(() => ({ label: "committed once" }));
    const failure: unknown = await patchSessionEntryCore(f.scope, update, {
      workerGuard: {
        source: composeSessionSourceAssertion(
          [releaseFirst, releaseLast].map((release) =>
            Object.assign(() => {}, {
              prepareSessionSource: async () => ({ assertCurrent() {}, checks: [], release }),
            }),
          ),
        ),
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      code: "outcome-unknown",
      cause: { code: "outcome-unknown", cause: replyFailure },
      errors: expect.arrayContaining([cleanupFailure]),
    });
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(loseCommitResult).toHaveBeenCalledOnce();
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(releaseLast).toHaveBeenCalledOnce();
    expect(f.read()?.label).toBe("committed once");
  });
});

it.each([false, true])(
  "releases prepared source custody when writer acquisition fails (cleanup failure: %s)",
  async (cleanupFails) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const acquisitionFailure = new Error("writer owner retired before acquisition");
      const cleanupFailure = new Error("prepared source release failed");
      const release = vi.fn(async () => {
        if (cleanupFails) {
          throw cleanupFailure;
        }
      });
      const capture = vi
        .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
        .mockImplementation(() => {
          throw acquisitionFailure;
        });
      const update = vi.fn(() => ({ label: "must not commit" }));
      try {
        const failure: unknown = await patchSessionEntryCore(f.scope, update, {
          workerGuard: {
            source: Object.assign(() => {}, {
              prepareSessionSource: async () => ({ assertCurrent() {}, checks: [], release }),
            }),
          },
        }).catch((error: unknown) => error);
        expect(release).toHaveBeenCalledOnce();
        if (cleanupFails) {
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure).toMatchObject({
            cause: acquisitionFailure,
            errors: [acquisitionFailure, cleanupFailure],
          });
        } else {
          expect(failure).toBe(acquisitionFailure);
        }
        expect(update).not.toHaveBeenCalled();
        expect(f.read()?.label).toBe("initial");
      } finally {
        capture.mockRestore();
      }
    });
  },
);

it("preserves the translated source refusal while joining failed preparation cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const refusal = new Error("source was revoked during preparation");
    const translated = new TypeError("caller source is no longer active", { cause: refusal });
    const cleanupFailure = new Error("retained source cleanup failed");
    const releaseFirst = vi.fn();
    const releaseLast = vi.fn(async () => {
      throw cleanupFailure;
    });
    const update = vi.fn(() => ({ label: "must not commit" }));
    const source = composeSessionSourceAssertion(
      [
        ...[releaseFirst, releaseLast].map((release) =>
          Object.assign(() => {}, {
            prepareSessionSource: async () => ({ assertCurrent() {}, checks: [], release }),
          }),
        ),
        Object.assign(() => {}, {
          prepareSessionSource: async () => {
            throw refusal;
          },
        }),
      ],
      (assertSources) => {
        try {
          assertSources();
        } catch (error) {
          throw error === refusal ? translated : error;
        }
      },
    );
    const failure: unknown = await patchSessionEntryCore(f.scope, update, {
      workerGuard: { source },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw failure;
    }
    expect(failure.cause).toBe(translated);
    expect(failure.errors[0]).toBe(translated);
    expect(failure.errors).toContain(cleanupFailure);
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(releaseLast).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(f.read()?.label).toBe("initial");
  });
});
