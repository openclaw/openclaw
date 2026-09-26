import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  isSqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as configEnv from "../config-env-vars.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";

it("does not probe archive recovery during ordinary replacements", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    try {
      // The native maintenance path exposes SQL from the same replacement kernel.
      await maintenance.run(async () => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const sessionKey = "agent:main:replacement-no-archive";
        writeSessionEntry(database, sessionKey, { sessionId: "replacement", updatedAt: 1 });
        ensureSessionTranscriptArchiveSchema(database.db);
        const sql = observeSqliteReadSql(StatementSync.prototype);
        try {
          await applySessionEntryExactReplacements({
            storePath: database.path,
            sessionKeys: [sessionKey],
            update: ([row]) => ({
              result: undefined,
              replacements: [{ sessionKey, entry: { ...row!.entry, label: "committed" } }],
            }),
          });
          expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("committed");
          expect(
            sql.queries.filter((query) => /from "session_transcript_archives"/i.test(query)),
          ).toEqual([]);
        } finally {
          sql.restore();
        }
      });
    } finally {
      await maintenance.close();
    }
  });
});

it("commits platform-normalized replacements without entering a caller-thread SQLite write transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const file = statSync(database.path, { bigint: true });
    const sessionKey = "agent:main:replacement-worker";
    writeSessionEntry(database, sessionKey, {
      sessionId: "replacement",
      lifecycleRevision: "initial-lifecycle",
      updatedAt: 1,
    });
    const mutations: SessionIdentityMutation[] = [];
    const normalized = withMockedPlatform("win32", () =>
      configEnv.cloneEnvWithPlatformSemantics(process.env),
    );
    expect(() => structuredClone(normalized)).toThrow();
    const clone = vi
      .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
      .mockReturnValueOnce(normalized);
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const exec = vi.spyOn(databasePrototype, "exec");
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      const token = {};
      expect(
        await applySessionEntryExactReplacements({
          agentId: "main",
          storePath: database.path,
          sessionKeys: [sessionKey],
          update: ([row]) => ({
            result: token,
            replacements: [{ sessionKey, entry: { ...row!.entry, label: "committed" } }],
          }),
        }),
      ).toBe(token);
      expect(mutations).toEqual([]);
      await applySessionEntryExactReplacements({
        agentId: "main",
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: ([row]) => ({
          result: undefined,
          replacements: [
            { sessionKey, entry: { ...row!.entry, lifecycleRevision: "next-lifecycle" } },
          ],
        }),
      });
      expect(mutations).toEqual([
        {
          agentId: "main",
          databaseIdentity: `${file.dev}:${file.ino}`,
          kind: "reset",
          previous: { sessionId: "replacement", sessionKeys: [sessionKey] },
          current: { sessionId: "replacement", sessionKeys: [sessionKey] },
        },
      ]);
      expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual([]);
    } finally {
      unsubscribe();
      exec.mockRestore();
      clone.mockRestore();
    }
    expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("committed");
  });
});

it("publishes committed sharing and reader invalidation before observers, and rolls back revoked canonical writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:replacement-publication";
    const targetKey = "agent:main:replacement-moved";
    const original = { sessionId: "publication", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const reader = new OpenClawAgentDatabaseReadOnlyScope();
    let readerDatabase: DatabaseSync | undefined;
    reader.read(
      (opened) => {
        readerDatabase = opened.db;
        return readSessionEntryCache(opened, { cache: true });
      },
      { agentId: "main", path: database.path },
    );
    const observed: unknown[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey) {
        observed.push({
          visibility: sharing.readCurrent()?.entry?.visibility,
          membership: [...(sharing.readCurrent()?.membership ?? [])],
          cache: readerDatabase && readCommittedSessionEntryCache(readerDatabase),
        });
      }
    });
    try {
      await applySessionEntryExactReplacements({
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: ([row]) => ({
          result: undefined,
          replacements: [{ sessionKey, entry: { ...row!.entry, visibility: "read-only" } }],
        }),
      });
      expect(observed).toEqual([
        { visibility: "read-only", membership: ["member"], cache: undefined },
      ]);
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      let current = true;
      const admitted = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              current = false;
            }
            return callback(request, grant);
          }, attachment),
        );
      const followup = vi.fn();
      const move = () =>
        applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey, targetKey],
          afterCommitted: followup,
          assertCommitAllowed() {
            if (!current) {
              throw new Error("Replacement authority revoked");
            }
          },
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: targetKey, previousSessionKeys: [sessionKey], entry: row!.entry },
            ],
          }),
        });
      try {
        await expect(move()).rejects.toThrow("Replacement authority revoked");
        expect(current).toBe(false);
        expect(followup).not.toHaveBeenCalled();
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe("read-only");
        expect(readExactSessionEntryRow(database, targetKey)).toBeUndefined();
        expect(observed).toHaveLength(1);
      } finally {
        admitted.mockRestore();
      }
      current = true;
      await move();
      expect(followup).toHaveBeenCalledOnce();
      expect(readExactSessionEntryRow(database, sessionKey)).toBeUndefined();
      expect(readExactSessionEntryRow(database, targetKey)?.entry).toMatchObject({
        ...original,
        visibility: "read-only",
      });
      expect(sharing.readCurrent()).toBeUndefined();
    } finally {
      stop();
      sharing.release();
      reader.close();
    }
  });
});

it("discovers the schema owner for an unkeyed exact-store replacement without host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "ops",
      path: state.statePath("shared.sqlite"),
    });
    const key = "agent:ops:unkeyed-replacement";
    writeSessionEntry(database, key, { sessionId: "unkeyed", updatedAt: 1 });
    const sql = observeHostDataSql();
    try {
      await applySessionEntryExactReplacements({
        storePath: database.path,
        update: (entries) => ({
          result: undefined,
          replacements: entries.map(({ sessionKey, entry }) => ({
            sessionKey,
            entry: { ...entry, label: "updated" },
          })),
        }),
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(readExactSessionEntryRow(database, key)?.entry.label).toBe("updated");
  });
});

it("creates a missing durable replacement database entirely through its worker owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("new-replacement.sqlite");
    const sessionKey = "agent:main:replacement-created";
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      await applySessionEntryCanonicalReplacements({
        storePath,
        sessionKeys: [sessionKey],
        update: (entries) => {
          expect(entries).toEqual([]);
          return {
            result: undefined,
            replacements: [
              {
                sessionKey,
                previousSessionKeys: [],
                entry: { sessionId: "created", updatedAt: 1 },
              },
            ],
          };
        },
      });
      expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual([]);
    } finally {
      exec.mockRestore();
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    expect(readExactSessionEntryRow(database, sessionKey)?.entry.sessionId).toBe("created");
  });
});

it("joins postcommit follow-up on close without granting a successor authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const key = "agent:main:followup-close";
    writeSessionEntry(database, key, { sessionId: "close", updatedAt: 1 });
    const entered = createDeferredCore<SessionEntryCommitContext>();
    const release = createDeferredCore();
    const order: string[] = [];
    const writing = applySessionEntryCanonicalReplacements({
      storePath: database.path,
      sessionKeys: [key],
      update: ([row]) => ({
        result: "durable",
        replacements: [
          { sessionKey: key, previousSessionKeys: [], entry: { ...row!.entry, label: "saved" } },
        ],
      }),
      afterCommitted: async (_result, source) => {
        source.assertCurrent();
        entered.resolve(source);
        await release.promise;
        expect(() => source.assertCurrent()).toThrow();
        order.push("followup-settled");
      },
    });
    const source = await Promise.race([
      entered.promise,
      writing.then(() => {
        throw new Error("missing follow-up");
      }),
    ]);
    const closing = closeOpenClawAgentDatabaseByPathAsync(database.path).then(() => {
      order.push("closed");
    });
    try {
      expect(() => source.assertCurrent()).toThrow();
      expect(order).toEqual([]);
    } finally {
      release.resolve();
      await closing;
    }
    expect(await writing).toBe("durable");
    expect(order).toEqual(["followup-settled", "closed"]);
    const reopened = openOpenClawAgentDatabase({ agentId: "main", path: database.path });
    expect(readExactSessionEntryRow(reopened, key)?.entry.label).toBe("saved");
    expect(() => source.assertCurrent()).toThrow();
  });
});

it("suppresses follow-up for no-write and transaction-revoked replacements", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const key = "agent:main:followup-refused";
    writeSessionEntry(database, key, { sessionId: "refused", updatedAt: 1 });
    const followup = vi.fn();
    await applySessionEntryCanonicalReplacements({
      storePath: database.path,
      sessionKeys: [key],
      update: () => ({ result: undefined }),
      afterCommitted: followup,
    });
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let current = true;
    const hook = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "transaction") {
            current = false;
          }
          callback(request, grant);
        }, attachment),
      );
    try {
      await expect(
        applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [key],
          afterCommitted: followup,
          assertCommitAllowed: () => {
            if (!current) {
              throw new Error("transaction revoked");
            }
          },
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: key,
                previousSessionKeys: [],
                entry: { ...row!.entry, label: "refused" },
              },
            ],
          }),
        }),
      ).rejects.toThrow("transaction revoked");
      expect(followup).not.toHaveBeenCalled();
      expect(readExactSessionEntryRow(database, key)?.entry.label).toBeUndefined();
    } finally {
      hook.mockRestore();
    }
  });
});

it("refuses a replaced pathname while retaining the committed native execution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = "agent:main:retained-path";
    const original = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("original", "store.sqlite"),
    });
    const successor = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("successor", "store.sqlite"),
    });
    writeSessionEntry(original, key, { sessionId: "original", updatedAt: 1 });
    writeSessionEntry(successor, key, { sessionId: "successor", updatedAt: 1 });
    const alias = state.statePath("selected");
    const heldAlias = state.statePath("selected-before");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(path.dirname(original.path), alias, linkType);
    await applySessionEntryCanonicalReplacements({
      agentId: "main",
      storePath: path.join(alias, "store.sqlite"),
      sessionKeys: [key],
      update: ([row]) => ({
        result: undefined,
        replacements: [
          { sessionKey: key, previousSessionKeys: [], entry: { ...row!.entry, label: "saved" } },
        ],
      }),
      afterCommitted: async (_result, source) => {
        source.assertCurrent();
        await fs.rename(alias, heldAlias);
        try {
          await fs.symlink(path.dirname(successor.path), alias, linkType);
          expect(() => source.assertCurrent()).toThrow();
        } finally {
          await fs.rm(alias, { recursive: true, force: true });
          await fs.rename(heldAlias, alias);
        }
      },
    });
    expect(readExactSessionEntryRow(original, key)?.entry).toMatchObject({
      sessionId: "original",
      label: "saved",
    });
    expect(readExactSessionEntryRow(successor, key)?.entry).toMatchObject({
      sessionId: "successor",
    });
    expect(readExactSessionEntryRow(successor, key)?.entry.label).toBeUndefined();
  });
});

it.each([
  "lost delivery after native completion",
  "lost result and commit receipt after final grant",
  "unknown native settlement after commit",
] as const)("settles canonical replacement with %s", async (fault) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:replacement-native-settlement";
    const entry = {
      sessionId: "native-settlement",
      lifecycleRevision: "same-lifecycle",
      updatedAt: 1,
    };
    writeSessionEntry(database, sessionKey, entry);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(entry),
      membership: new Set(["member"]),
    });
    const observed: unknown[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey) {
        const current = sharing.readCurrent();
        observed.push(
          current && {
            visibility: current.entry?.visibility,
            membership: [...current.membership],
          },
        );
      }
    });
    const deliveryFailure = new Error("Replacement committed but its reply was lost");
    const missingReceipt = fault === "lost result and commit receipt after final grant";
    const nativeUnknown = fault === "unknown native settlement after commit";
    const committedLifecycle = vi.fn();
    const followup = vi.fn();
    let verifiedCommits = 0;
    const restoreFaults: Array<() => void> = [];
    const original = workerStore.runSqliteWorkerStoreOperation;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          target: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
          requireStateLifecycle?: Parameters<typeof original>[5],
        ) => {
          let replacing = false;
          let injected = false;
          let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
          let nativeRetention: RetainedWorkerTransactionAdmission | undefined;
          return original(
            target,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  replacing = command.type === "session.entries.replace";
                  const result = await worker.execute(command, options);
                  if (!replacing) {
                    return result;
                  }
                  // Read committed first: its owner drains queued native port messages.
                  expect(nativeAdmission?.committed).toMatchObject({
                    facts: { kind: "session-entry-replacements", changedKeys: [sessionKey] },
                  });
                  const nativeSettlement = nativeAdmission?.settlement;
                  expect(nativeSettlement).toMatchObject({
                    kind: "completed",
                    committed: { facts: { kind: "session-entry-replacements" } },
                  });
                  expect(await nativeRetention?.settled).toEqual({ kind: "completed" });
                  expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe(
                    "read-only",
                  );
                  if (!nativeAdmission || !nativeSettlement) {
                    throw new Error("Real replacement did not provide native settlement");
                  }
                  if (missingReceipt) {
                    const receipt = vi
                      .spyOn(nativeAdmission, "committed", "get")
                      .mockReturnValue(undefined);
                    const settlement = vi
                      .spyOn(nativeAdmission, "settlement", "get")
                      .mockReturnValue({ kind: "completed" });
                    restoreFaults.push(
                      () => receipt.mockRestore(),
                      () => settlement.mockRestore(),
                    );
                  } else if (nativeUnknown) {
                    const settlement = vi
                      .spyOn(nativeAdmission, "settlement", "get")
                      .mockReturnValue({ ...nativeSettlement, kind: "unknown" });
                    restoreFaults.push(() => settlement.mockRestore());
                  }
                  verifiedCommits++;
                  injected = true;
                  if (!nativeUnknown) {
                    throw deliveryFailure;
                  }
                  return result;
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission &&
              ((retained) => {
                if (!replacing) {
                  return createAdmission(retained);
                }
                nativeRetention = retained;
                const owned = createAdmission({
                  get settled() {
                    return retained.settled.then((settlement) =>
                      injected && fault === "lost delivery after native completion"
                        ? { kind: "unknown" as const, error: deliveryFailure }
                        : settlement,
                    );
                  },
                });
                nativeAdmission = owned.admission;
                return owned;
              }),
            requireStateLifecycle,
          );
        },
      );
    try {
      const replacement = applySessionEntryCanonicalReplacements({
        agentId: "main",
        storePath: database.path,
        sessionKeys: [sessionKey],
        onLifecycleCommitted: committedLifecycle,
        afterCommitted: followup,
        update: ([row]) => ({
          result: "replacement-result",
          replacements: [
            {
              sessionKey,
              previousSessionKeys: [],
              entry: { ...row!.entry, visibility: "read-only" },
            },
          ],
        }),
      });
      const outcome = await replacement.then(
        (value) => ({ kind: "returned" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      expect(verifiedCommits).toBe(1);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") {
        throw new Error("Uncertain replacement unexpectedly continued");
      }
      if (missingReceipt || nativeUnknown) {
        expect(isSqliteWorkerError(outcome.error, "outcome-unknown")).toBe(true);
      } else {
        expect(outcome.error).toBe(deliveryFailure);
      }
      expect(followup).not.toHaveBeenCalled();
      expect(committedLifecycle).toHaveBeenCalledTimes(missingReceipt ? 0 : 1);
      expect(observed).toEqual([
        missingReceipt ? undefined : { visibility: "read-only", membership: ["member"] },
      ]);
      expect(sharing.readCurrent()?.entry?.visibility).toBe(
        missingReceipt ? undefined : "read-only",
      );
      expect(readExactSessionEntryRow(database, sessionKey)?.entry).toMatchObject({
        ...entry,
        visibility: "read-only",
      });
    } finally {
      for (const restore of restoreFaults.toReversed()) {
        restore();
      }
      observer.mockRestore();
      stop();
      sharing.release();
    }
  });
});
