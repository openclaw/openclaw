import { AsyncLocalStorage } from "node:async_hooks";
import { deserialize, serialize } from "node:v8";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainPreparedSessionGenerationFacts } from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  readUnchangedLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  patchSessionEntryCore as patchInternalSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "./session-transcript-index.js";
import * as reconcile from "./session-transcript-reconcile.js";
import type { SessionEntry } from "./types.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const delivery = vi.hoisted(() => ({ afterCommit: undefined as (() => void) | undefined }));
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
                  const result = await worker.execute(command, commandOptions);
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
  delivery.afterCommit = undefined;
  vi.restoreAllMocks();
});

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:patch-worker",
  };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1, label: "initial" });
  return {
    database,
    scope,
    read: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
  };
}

function patchSessionEntryCore(
  ...[scope, update, options]: Parameters<typeof patchInternalSessionEntry>
) {
  return patchInternalSessionEntry(scope, update, { workerGuard: {}, ...options });
}

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

it("evaluates the active-leaf predicate on the patch transaction's uncommitted transcript", async () => {
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
                  appendTranscriptEventsInTransaction(database, scope, [event("pending", "root")]);
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
      expect(f.read()?.label).toBe("transaction leaf accepted");
    } finally {
      observer.close();
      port1.close();
      port2.close();
    }
  });
});

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
    let current = true;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          callback(request, grant);
        }, attachment),
    );
    const changeDuringUpdate = () => {
      replaceSessionEntrySync(f.scope, { sessionId: "replacement", updatedAt: 2, label: "newer" });
      return null;
    };
    await expect(
      patchSessionEntryCore(f.scope, changeDuringUpdate, {
        workerGuard: {
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
    ).resolves.toBeNull();
    expect(f.read()?.label).toBe("newer");
    vi.restoreAllMocks();
    const conflict = patchSessionEntryCore(f.scope, () => {
      replaceSessionEntrySync(f.scope, { sessionId: "another", updatedAt: 3 });
      return null;
    });
    await expect(conflict).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
    await expect(conflict).rejects.toThrow("state changed while preparing");
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
