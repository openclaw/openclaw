import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { trimTranscriptForManualCompact } from "./session-accessor.sqlite-compaction.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.js";
import { trimSessionTranscriptForManualCompact } from "./session-accessor.transcript.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { captureSessionEntryCurrentCheck } from "./session-entry-current-check.js";
import * as rewrite from "./session-message-rewrite-domain.js";
import { createManualCompactRecords } from "./transcript-message.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("trims through the worker and clears accounting without host data SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    replaceSessionEntrySync(f.scope, {
      sessionId: f.scope.sessionId,
      updatedAt: 1,
      inputTokens: 10,
      totalTokens: 30,
      totalTokensFresh: true,
      cliSessionIds: { synthetic: "obsolete" },
    });
    replaceTranscriptEventsSync(f.scope, createManualCompactRecords(f.scope.sessionId));
    const sql = observeHostDataSql();
    try {
      await expect(
        trimSessionTranscriptForManualCompact(f.scope, { maxLines: 3, nowMs: 500 }),
      ).resolves.toEqual({ compacted: true, kept: 3 });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(f.events()).toMatchObject([
      { type: "session", id: f.scope.sessionId },
      { id: "entry-3", parentId: null },
      { id: "entry-4", parentId: "entry-3" },
    ]);
    const entry = f.read();
    expect(entry?.updatedAt).toBe(500);
    expect(entry?.inputTokens).toBeUndefined();
    expect(entry?.totalTokens).toBeUndefined();
    expect(entry?.cliSessionIds).toBeUndefined();
  });
});

it("rolls back transcript and accounting when host authority closes at commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const records = createManualCompactRecords(f.scope.sessionId);
    replaceTranscriptEventsSync(f.scope, records);
    const before = f.read();
    let live = true;
    let commitRequested = false;
    probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit") {
        commitRequested = true;
        live = false;
      }
      callback(request, grant);
    });
    await expect(
      trimSessionTranscriptForManualCompact(f.scope, {
        maxLines: 3,
        authority: {
          expectedLifecycleRevision: before?.lifecycleRevision,
          source: () => {},
          assertHostCurrent: () => {
            if (!live) {
              throw new Error("manual compaction authority closed");
            }
          },
        },
      }),
    ).rejects.toThrow("manual compaction authority closed");
    expect(commitRequested).toBe(true);
    expect(f.events()).toEqual(records);
    expect(f.read()).toEqual(before);
  });
});

it("rejects an entry rebound after prepared manual-compaction admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const records = createManualCompactRecords(f.scope.sessionId);
    replaceTranscriptEventsSync(f.scope, records);
    const before = f.read()!;
    const execute = rewrite.executeSessionMessageRewriteOperation;
    vi.spyOn(rewrite, "executeSessionMessageRewriteOperation").mockImplementation((...args) => {
      replaceSessionEntrySync(f.scope, { ...before, lifecycleRevision: "successor" });
      return execute(...args);
    });
    await expect(
      trimSessionTranscriptForManualCompact(f.scope, {
        maxLines: 3,
        authority: {
          source: () => {},
          assertHostCurrent: () => {},
          expectedLifecycleRevision: before.lifecycleRevision,
        },
      }),
    ).rejects.toThrow(
      "SQLite session state changed while preparing session.transcript.manual-compact",
    );
    expect(f.events()).toEqual(records);
    expect(f.read()?.lifecycleRevision).toBe("successor");
  });
});

it("rechecks a foreign source changed during the commit grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const records = createManualCompactRecords(f.scope.sessionId);
    replaceTranscriptEventsSync(f.scope, records);
    const before = f.read()!;
    const foreignScope = {
      ...f.scope,
      storePath: path.join(path.dirname(f.database.path), "foreign.sqlite"),
    };
    replaceSessionEntrySync(foreignScope, before);
    const foreign = openOpenClawAgentDatabase({ agentId: "main", path: foreignScope.storePath });
    const identity = readOpenClawAgentDatabaseIdentity(foreign);
    let changed = false;
    probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit") {
        replaceSessionEntrySync(foreignScope, { ...before, label: "revoked" });
        changed = true;
      }
      callback(request, grant);
    });
    const source = Object.assign(() => {}, {
      async prepareSessionSource() {
        return {
          assertCurrent() {},
          checks: [
            {
              predicate: {
                source: {
                  agentId: "main",
                  path: foreignScope.storePath,
                  databaseIdentity: identity.identity,
                  databaseBirthtime: identity.birthtime,
                },
                sessionKey: foreignScope.sessionKey,
                fields: ["label" as const],
                expected: { label: before.label },
              },
              refuse(): never {
                throw new Error("Foreign compaction source revoked");
              },
            },
          ],
        };
      },
    });
    await expect(
      trimSessionTranscriptForManualCompact(f.scope, {
        maxLines: 3,
        authority: {
          source,
          assertHostCurrent() {},
          expectedLifecycleRevision: before.lifecycleRevision,
        },
      }),
    ).rejects.toThrow(/source changed|source revoked|confirmed native completion/i);
    expect(changed).toBe(true);
    expect(f.events()).toEqual(records);
    expect(f.read()).toEqual(before);
  });
});

it.each([
  { boundary: "dispatch", revoked: 0, bothActive: false, succeeds: false },
  { boundary: "dispatch", revoked: 1, bothActive: false, succeeds: true },
  { boundary: "commit", revoked: 0, bothActive: false, succeeds: false },
  { boundary: "commit", revoked: 0, bothActive: true, succeeds: true },
] as const)(
  "keeps conversation alternatives live at $boundary (revoked=$revoked, bothActive=$bothActive)",
  async ({ boundary, revoked, bothActive, succeeds }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const records = createManualCompactRecords(f.scope.sessionId);
      replaceTranscriptEventsSync(f.scope, records);
      const before = f.read()!;
      const sourceScope = {
        ...f.scope,
        storePath: path.join(path.dirname(f.database.path), "foreign.sqlite"),
      };
      replaceSessionEntrySync(sourceScope, before);
      const sourceOptions = { agentId: sourceScope.agentId, path: sourceScope.storePath };
      const conversations = ["active", "alternative"].map((peerId) => {
        const identity = buildConversationIdentity({
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId,
          deliveryTarget: peerId,
        });
        if (!identity) {
          throw new Error("Expected a valid manual-compaction conversation");
        }
        return identity;
      });
      const encoded = prepareConversationIdentities(conversations);
      runOpenClawAgentWriteTransaction((database) => {
        upsertConversationIdentities(database, encoded, 1);
        for (const identity of conversations) {
          linkSessionConversation({
            database,
            sessionId: sourceScope.sessionId,
            conversation: { identity, role: "participant" },
            updatedAt: 1,
          });
        }
      }, sourceOptions);
      const current = await captureSessionEntryCurrentCheck({
        ...sourceScope,
        alternatives: conversations.map((identity, index) => ({
          conversations: [{ ...identity, sessionKey: sourceScope.sessionKey }],
          isActive: () => index === 0 || bothActive,
        })),
        errorMessage: "Manual-compaction conversation authority revoked",
      });
      let changed = false;
      const revoke = () => {
        runOpenClawAgentWriteTransaction((database) => {
          linkSessionConversation({
            database,
            sessionId: sourceScope.sessionId,
            conversation: { identity: conversations[revoked]!, role: "related" },
            updatedAt: 2,
          });
        }, sourceOptions);
        changed = true;
      };
      if (boundary === "dispatch") {
        const execute = rewrite.executeSessionMessageRewriteOperation;
        vi.spyOn(rewrite, "executeSessionMessageRewriteOperation").mockImplementation((...args) => {
          if (args[2].type === "session.transcript.manualCompact") {
            revoke();
          }
          return execute(...args);
        });
      } else {
        const create = admission.createSqliteWorkerOperationAdmission;
        vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (callback, attachment) =>
            create((request, grant) => {
              if (request.stage === "commit") {
                revoke();
              }
              callback(request, grant);
            }, attachment),
        );
      }
      const compact = trimSessionTranscriptForManualCompact(f.scope, {
        maxLines: 3,
        authority: {
          source: current.assertCurrent,
          assertHostCurrent() {},
          expectedLifecycleRevision: before.lifecycleRevision,
        },
      });
      if (succeeds) {
        await expect(compact).resolves.toEqual({ compacted: true, kept: 3 });
        expect(f.events()).toHaveLength(3);
      } else {
        await expect(compact).rejects.toThrow(
          /authority revoked|source changed|confirmed native completion/i,
        );
        expect(f.events()).toEqual(records);
        expect(f.read()).toEqual(before);
      }
      expect(changed).toBe(true);
    });
  },
);

it("rolls back the native manual trim when accounting cannot be cleared", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const records = createManualCompactRecords(f.scope.sessionId);
    replaceTranscriptEventsSync(f.scope, records);
    const before = f.read();
    f.database.db.exec(`
      CREATE TEMP TRIGGER reject_manual_compact_metadata_update
      BEFORE UPDATE OF entry_json ON main.session_nodes
      BEGIN
        SELECT RAISE(ABORT, 'injected manual compact metadata failure');
      END;
    `);
    try {
      await expect(
        trimTranscriptForManualCompact(f.scope, (lines) => [lines[0]!, ...lines.slice(-2)], {
          nowMs: 500,
        }),
      ).rejects.toThrow("injected manual compact metadata failure");
    } finally {
      f.database.db.exec("DROP TRIGGER reject_manual_compact_metadata_update");
    }
    expect(f.events()).toEqual(records);
    expect(f.read()).toEqual(before);
  });
});
