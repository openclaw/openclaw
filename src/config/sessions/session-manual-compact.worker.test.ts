import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { trimSessionTranscriptForManualCompact } from "./session-accessor.transcript.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";
import * as rewrite from "./session-message-rewrite-domain.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";
import * as reconcile from "./session-transcript-reconcile.js";
import { createManualCompactRecords, messageEvent } from "./transcript-message.test-support.js";

const metadataFault = useSqliteWorkerFault([
  {
    name: "reject_manual_compact_metadata_update",
    match: /^insert into session_nodes\b/iu,
    sql: `CREATE TEMP TRIGGER reject_manual_compact_metadata_update
      BEFORE UPDATE OF entry_json ON main.session_nodes
      BEGIN SELECT RAISE(ABORT, 'injected manual compact metadata failure'); END;`,
  },
]);

afterEach(() => vi.restoreAllMocks());

function fixture(seed = true) {
  const f = createSessionCompoundWorkerFixture();
  replaceSessionEntrySync(f.scope, {
    sessionId: f.scope.sessionId,
    updatedAt: 1,
    inputTokens: 10,
    totalTokens: 30,
    totalTokensFresh: true,
    cliSessionIds: { synthetic: "obsolete" },
  });
  const records = createManualCompactRecords(f.scope.sessionId);
  if (seed) {
    replaceTranscriptEventsSync(f.scope, records);
  }
  const before = f.read()!;
  return {
    ...f,
    records,
    before,
    compact: (params: Partial<Parameters<typeof trimSessionTranscriptForManualCompact>[1]> = {}) =>
      trimSessionTranscriptForManualCompact(f.scope, { maxLines: 3, ...params }),
    authority: {
      source() {},
      assertHostCurrent() {},
      expectedLifecycleRevision: before.lifecycleRevision,
    },
    expectUnchanged() {
      expect(f.events()).toEqual(records);
      expect(f.read()).toEqual(before);
    },
    foreignScope: {
      ...f.scope,
      storePath: path.join(path.dirname(f.database.path), "foreign.sqlite"),
    },
  };
}

it("trims compressed history into a ready next-turn projection and clears accounting", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture(false);
    vi.spyOn(reconcile, "startSessionTranscriptIndexReconcile").mockImplementation(() => {});
    runOpenClawAgentWriteTransaction(
      (database) =>
        replaceSqliteTranscriptEventsInTransaction(
          database,
          resolveSqliteTranscriptScope(f.scope),
          [
            createManualCompactRecords(f.scope.sessionId)[0]!,
            ...Array.from({ length: 4_100 }, (_, index) =>
              messageEvent(`entry-${index + 1}`, index === 0 ? null : `entry-${index}`, {
                role: "user",
                content: index === 0 ? "old payload ".repeat(130_000) : `message ${index + 1}`,
                timestamp: index + 1,
              }),
            ),
          ],
          { scheduleProjectionReconcile: false },
        ),
      { agentId: f.scope.agentId, path: f.database.path },
    );
    runOpenClawAgentWriteTransaction(
      (database) => reconcileSessionTranscriptIndexInTransaction(database.db, f.scope.sessionId),
      { agentId: f.scope.agentId, path: f.database.path },
    );
    expect(
      f.database.db
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE event_zstd IS NOT NULL")
        .get(),
    ).toEqual({ count: 1 });
    const prior = readSessionTranscriptWatermark(f.scope);
    replaceSessionEntrySync(f.scope, {
      ...f.read()!,
      worktree: { id: "adopted", branch: "pr", repoRoot: "/synthetic/current" },
      priorWorkspace: {
        worktreeId: "adopted",
        sessionId: f.scope.sessionId,
        workspaceDir: "/synthetic/original",
        fileRoot: "/synthetic/original",
        through: { generation: prior.generation, maxSeq: 4099 },
      },
    });

    await expect(f.compact({ nowMs: 500 })).resolves.toEqual({ compacted: true, kept: 3 });
    expect(f.events()).toHaveLength(3);
    const nextContext = await readSessionTranscriptModelContextInWorker(f.scope, undefined);
    expect(nextContext.events).toMatchObject([
      { type: "session", id: f.scope.sessionId },
      { id: "entry-4099", parentId: null, message: { content: "message 4099" } },
      { id: "entry-4100", parentId: "entry-4099", message: { content: "message 4100" } },
    ]);
    const entry = f.read();
    expect(entry?.updatedAt).toBe(500);
    expect(entry?.inputTokens).toBeUndefined();
    expect(entry?.totalTokens).toBeUndefined();
    expect(entry?.cliSessionIds).toBeUndefined();
    const current = readSessionTranscriptWatermark(f.scope);
    expect(current.generation).not.toBe(prior.generation);
    expect(entry?.priorWorkspace?.through).toEqual({ generation: current.generation, maxSeq: 1 });
  }));

it("rolls back transcript and accounting when host authority closes at commit", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
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
      f.compact({
        authority: {
          ...f.authority,
          assertHostCurrent: () => {
            if (!live) {
              throw new Error("manual compaction authority closed");
            }
          },
        },
      }),
    ).rejects.toThrow("manual compaction authority closed");
    expect(commitRequested).toBe(true);
    f.expectUnchanged();
  }));

it("rejects an entry rebound after prepared manual-compaction admission", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const execute = rewrite.executeSessionMessageRewriteOperation;
    vi.spyOn(rewrite, "executeSessionMessageRewriteOperation").mockImplementation((...args) => {
      replaceSessionEntrySync(f.scope, { ...f.before, lifecycleRevision: "successor" });
      return execute(...args);
    });
    await expect(f.compact({ authority: f.authority })).rejects.toThrow(
      "SQLite session state changed while preparing session.transcript.manual-compact",
    );
    expect(f.events()).toEqual(f.records);
    expect(f.read()?.lifecycleRevision).toBe("successor");
  }));

it("rechecks a foreign source changed during the commit grant", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const { before, foreignScope } = f;
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
    await expect(f.compact({ authority: { ...f.authority, source } })).rejects.toThrow(
      /source changed|source revoked|confirmed native completion/i,
    );
    expect(changed).toBe(true);
    f.expectUnchanged();
  }));

it.each([
  { boundary: "dispatch", bothActive: false },
  { boundary: "commit", bothActive: false },
  { boundary: "commit", bothActive: true },
] as const)(
  "rechecks conversation bindings at $boundary (both active: $bothActive)",
  ({ boundary, bothActive }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const sourceScope = f.foreignScope;
      replaceSessionEntrySync(sourceScope, f.before);
      const sourceOptions = { agentId: sourceScope.agentId, path: sourceScope.storePath };
      const conversations = ["active", "alternative"].map((peerId) => {
        const identity = buildConversationIdentity({
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId,
          deliveryTarget: peerId,
        });
        assert(identity);
        return identity;
      });
      runOpenClawAgentWriteTransaction((database) => {
        upsertConversationIdentities(database, prepareConversationIdentities(conversations), 1);
        for (const identity of conversations) {
          linkSessionConversation({
            database,
            sessionId: sourceScope.sessionId,
            conversation: { identity, role: "participant" },
            updatedAt: 1,
          });
        }
      }, sourceOptions);
      const current = await captureSessionEntryCurrentCheckAsyncInternal({
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
            conversation: { identity: conversations[0]!, role: "related" },
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
        probe.admission(admission, (request, grant, callback) => {
          if (request.stage === "commit") {
            revoke();
          }
          callback(request, grant);
        });
      }
      const compact = f.compact({ authority: { ...f.authority, source: current.source } });
      if (bothActive) {
        await expect(compact).resolves.toEqual({ compacted: true, kept: 3 });
        expect(f.events()).toHaveLength(3);
      } else {
        await expect(compact).rejects.toThrow(
          /authority revoked|source changed|confirmed native completion/i,
        );
        f.expectUnchanged();
      }
      expect(changed).toBe(true);
    }),
);

it("rolls back the worker manual trim when accounting cannot be cleared", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    metadataFault.enable();
    try {
      await expect(f.compact({ nowMs: 500 })).rejects.toThrow(
        "injected manual compact metadata failure",
      );
    } finally {
      metadataFault.disable();
    }
    f.expectUnchanged();
  }));
