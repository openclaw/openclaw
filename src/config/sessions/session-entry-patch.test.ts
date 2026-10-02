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
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readExactSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  readUnchangedLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  patchSessionEntryCore as patchInternalSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";

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
    await expect(
      patchSessionEntryCore(f.scope, () => {
        replaceSessionEntrySync(f.scope, { sessionId: "another", updatedAt: 3 });
        return null;
      }),
    ).rejects.toThrow("state changed while preparing");
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
