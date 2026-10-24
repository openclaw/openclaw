import { realpathSync, symlinkSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  createTempDirTracker,
  useAutoCleanupTempDirTracker,
} from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { resolveCurrentConversationSession } from "./conversation-registry.js";
import {
  appendTranscriptMessageSync as appendMessage,
  applySessionEntryLifecycleMutation,
  createSessionEntryWithTranscript,
  forkSessionAtMessage,
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptSuffixEventsSync as replaceSuffix,
  resetSessionEntryLifecycle,
  resolveSessionParentForkDecision,
  rewindSessionToMessage,
  switchSessionBranch,
} from "./session-accessor.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import { forkSessionEntryFromParentTargetWithPatch } from "./session-accessor.sqlite-parent-session.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "./session-accessor.sqlite-transcript-write.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { trimSessionTranscriptForManualCompact } from "./session-accessor.transcript.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import { maintenanceConfig } from "./session-cold-storage.test-support.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { createManualCompactRecords } from "./transcript-message.test-support.js";
import type { SessionEntry } from "./types.js";

// mock-isolation: Explicit cold archival owns this suite; automatic age retention is tested separately.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite: () => {},
}));

const tempDirs = createTempDirTracker();
const stores: string[] = [];
let seedStorePath: string | undefined;
const seedDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    if (seedStorePath) {
      await closeOpenClawAgentDatabaseByPathAsync(seedStorePath, "main");
    }
    cleanup();
    seed = undefined;
    seedStorePath = undefined;
  });
});
let seed:
  | {
      snapshotPath: string;
      archivePath: string;
      archiveName: string;
      original: ReturnType<typeof loadTranscriptEventsSync>;
    }
  | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  memorySessionActorOwners.reset();
  for (const storePath of stores.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: storePath });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

beforeAll(async () => {
  const root = seedDirs.make("openclaw-cold-lifecycle-seed-");
  seedStorePath = path.join(root, "openclaw-agent.sqlite");
  let fixture: Fixture;
  try {
    fixture = await createColdCurrentSession(seedStorePath);
  } finally {
    try {
      await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: seedStorePath });
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(seedStorePath, "main");
    }
  }
  expect(fixture.descriptor.storage).toBe("file");
  const snapshotPath = path.join(root, "seed.sqlite");
  await createVerifiedSqliteSnapshot({
    sourcePath: seedStorePath,
    targetPath: snapshotPath,
    requireNonEmptySource: true,
    preserveRowIds: true,
  });
  seed = {
    snapshotPath,
    archivePath: fixture.archivePath,
    archiveName: fixture.descriptor.archive_name,
    original: fixture.original,
  };
});

async function createColdCurrentSession(
  storePath = path.join(tempDirs.make("openclaw-cold-lifecycle-"), "openclaw-agent.sqlite"),
) {
  if (seed) {
    stores.push(storePath);
  }
  const scope = {
    agentId: "main",
    storePath,
    sessionId: "cold-current",
    sessionKey: "agent:main:cold-lifecycle",
  };
  const entry = { sessionId: scope.sessionId, updatedAt: 1, lifecycleRevision: "cold-revision" };
  const options = { agentId: scope.agentId, path: storePath };
  let original: ReturnType<typeof loadTranscriptEventsSync>;
  const template = seed;
  if (template) {
    await fs.copyFile(template.snapshotPath, storePath, fs.constants.COPYFILE_EXCL);
    const archivePath = resolveSessionColdArchivePath(storePath, template.archiveName);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.copyFile(template.archivePath, archivePath, fs.constants.COPYFILE_EXCL);
    original = structuredClone(template.original);
  } else {
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "Question" },
      },
      {
        type: "message",
        id: "answer",
        parentId: "question",
        message: { role: "assistant", content: "Original answer" },
      },
      {
        type: "message",
        id: "alternate",
        parentId: "question",
        message: { role: "assistant", content: "Alternate answer" },
      },
      { type: "leaf", id: "selection", parentId: "alternate", targetId: "answer" },
    ]);
    await waitForSessionTranscriptIndexReconcile(options);
    await replaceSessionEntry(scope, { ...loadSessionEntry(scope), ...entry });
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", scope.sessionId),
      );
    }, options);
    original = loadTranscriptEventsSync(scope);
    await expect(
      runSessionColdStorageMaintenance({
        config: maintenanceConfig(storePath),
      }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
  }
  const database = () => openOpenClawAgentDatabase(options).db;
  const descriptor = readSessionColdTranscript(database(), scope.sessionId);
  if (!descriptor) {
    throw new Error("Expected cold current transcript");
  }
  expect(() => loadTranscriptEventsSync(scope)).toThrow(/cold storage/);
  const snapshot = () =>
    [
      "session_nodes",
      "session_windows",
      "transcript_events",
      "transcript_event_identities",
      "transcript_rewrite_watermarks",
      "session_transcript_cold_archives",
      "session_transcript_active_events",
      "session_transcript_index_state",
    ].map((table) =>
      database()
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .toSorted(),
    );
  return {
    scope,
    entry,
    original,
    database,
    descriptor,
    snapshot,
    archivePath: resolveSessionColdArchivePath(storePath, descriptor.archive_name),
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
  };
}

type Fixture = Awaited<ReturnType<typeof createColdCurrentSession>>;

type WorkerParams = Extract<
  Parameters<typeof archiveWorkers.runSqliteTranscriptArchiveWorkerOperation>[0],
  { expectedMessageType: "reclaimed" }
>;
function interceptRestoration(rewrite: (params: WorkerParams) => WorkerParams) {
  const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
  vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
    (params) => original(params.expectedMessageType === "reclaimed" ? rewrite(params) : params),
  );
}

function coldDescriptor(fixture: Fixture) {
  return readSessionColdTranscript(fixture.database(), fixture.scope.sessionId);
}

function observeCommit(beforeCommit = () => {}) {
  const commit = { requested: false, inGrant: false };
  interceptRestoration((params) => ({
    ...params,
    onCommitRequest: () => {
      commit.requested = true;
      beforeCommit();
      commit.inGrant = true;
      try {
        params.onCommitRequest();
      } finally {
        commit.inGrant = false;
      }
    },
  }));
  return commit;
}

it.each<[string, string | undefined, Partial<SessionEntry>]>([
  ["lifecycle rebound", "selected", { lifecycleRevision: "successor" }],
  ["missing lifecycle rebound", undefined, { lifecycleRevision: "successor" }],
  ["archived", "selected", { archivedAt: 1 }],
  ["initialization pending", "selected", { initializationPending: true }],
])("refuses memory compaction after %s", async (_change, selectedRevision, patch) => {
  const agentId = "main";
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-incognito-compact-authority-") };
  const scope = {
    agentId,
    env,
    sessionId: "incognito-manual-compact",
    sessionKey: "agent:main:dashboard:incognito-manual-compact",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  };
  const initialEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: selectedRevision,
    incognito: true as const,
    updatedAt: Date.now(),
  };
  const records = createManualCompactRecords(scope.sessionId);
  await createSessionEntryWithTranscript(scope, () => ({
    ok: true,
    entry: initialEntry,
    transcriptEvents: records,
  }));
  await replaceSessionEntry(scope, { ...initialEntry, ...patch });
  const entryBeforeCompact = loadSessionEntry(scope);

  await expect(
    trimSessionTranscriptForManualCompact(scope, {
      maxLines: 3,
      authority: {
        source: () => {},
        assertHostCurrent: () => {},
        expectedLifecycleRevision: selectedRevision,
      },
    }),
  ).rejects.toThrow("Session changed before compaction. Retry.");

  await expect(loadTranscriptEvents(scope)).resolves.toEqual(records);
  expect(loadSessionEntry(scope)).toEqual(entryBeforeCompact);
});

function createCompactAuthority(
  fixture: Pick<Fixture, "scope" | "entry">,
  denied = false,
  selected: { lifecycleRevision?: string } = fixture.entry,
) {
  const database = openOpenClawAgentDatabase({
    agentId: fixture.scope.agentId,
    path: realpathSync(fixture.scope.storePath),
  });
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const expected = { ...fixture.entry, label: denied ? "required grant" : undefined };
  let current = true;
  const refuse = (): never => {
    throw new Error("Compaction source authority revoked");
  };
  const assertCurrent = () => {
    if (!current) {
      refuse();
    }
  };
  const source: SessionSourceAssertion = Object.assign(
    () => {
      assertCurrent();
      if (loadSessionEntry(fixture.scope)?.label !== expected.label) {
        refuse();
      }
    },
    {
      async prepareSessionSource() {
        return {
          assertCurrent,
          checks: [
            {
              predicate: {
                source: {
                  agentId: database.agentId,
                  path: fixture.scope.storePath,
                  databaseIdentity: identity.identity,
                  databaseBirthtime: identity.birthtime,
                },
                sessionKey: fixture.scope.sessionKey,
                fields: ["label" as const],
                expected,
              },
              refuse,
            },
          ],
        };
      },
    },
  );
  return {
    source,
    revoke: () => {
      current = false;
    },
    trim: (selectedSource = source) =>
      trimSessionTranscriptForManualCompact(fixture.scope, {
        maxLines: 3,
        authority: {
          source: selectedSource,
          assertHostCurrent: () => {},
          expectedLifecycleRevision: selected.lifecycleRevision,
        },
      }),
  };
}

const actions = [
  "reset",
  "batched reset",
  "fork",
  "rewind",
  "branch switch",
  "branch list",
  "parent fork",
  "cross-store parent fork",
  "parent entry fork",
  "parent decision",
] as const;
type Action = (typeof actions)[number];

async function runAction(action: Action, fixture: Fixture) {
  const { scope, entry, target } = fixture;
  const resetBoundary = {
    context: "clear" as const,
    reason: "reset" as const,
    cwd: path.dirname(scope.storePath),
  };
  switch (action) {
    case "reset":
      await resetSessionEntryLifecycle({
        storePath: scope.storePath,
        target,
        resetBoundary,
        buildNextEntry: () => ({ ...entry, sessionId: "reset-next", updatedAt: 2 }),
      });
      return loadSessionEntry(scope);
    case "batched reset":
      await applySessionEntryLifecycleMutation({
        storePath: scope.storePath,
        skipMaintenance: true,
        upserts: [
          {
            sessionKey: scope.sessionKey,
            entry: { ...entry, sessionId: "reset-next", updatedAt: 2 },
            resetBoundary,
          },
        ],
      });
      return loadSessionEntry(scope);
    case "fork":
      return forkSessionAtMessage({
        ...scope,
        entryId: "question",
        targetKey: "agent:main:forked",
      });
    case "rewind":
      return rewindSessionToMessage({ ...scope, entryId: "question" });
    case "branch switch":
      return switchSessionBranch({ ...scope, leafEntryId: "alternate" });
    case "branch list":
      return listSessionBranches(scope);
    case "parent fork":
    case "cross-store parent fork": {
      const targetStorePath =
        action === "cross-store parent fork"
          ? path.join(tempDirs.make("openclaw-cold-parent-target-"), "openclaw-agent.sqlite")
          : undefined;
      if (targetStorePath) {
        stores.push(targetStorePath);
      }
      return forkSessionFromParentTranscript({
        ...scope,
        parentEntry: entry,
        parentSessionKey: scope.sessionKey,
        sessionKey: "agent:main:child",
        targetStorePath,
      });
    }
    case "parent entry fork":
      return forkSessionEntryFromParentTarget({
        agentId: scope.agentId,
        storePath: scope.storePath,
        parentTarget: target,
        sessionTarget: { canonicalKey: "agent:main:child", storeKeys: ["agent:main:child"] },
        fallbackEntry: { sessionId: "child-initial", updatedAt: 2 },
      });
    case "parent decision":
      return resolveSessionParentForkDecision({ parentEntry: entry, storePath: scope.storePath });
  }
  return action satisfies never;
}

describe("cold current transcript lifecycle", () => {
  it("refuses synchronous writes to cold current history without mutating or restoring it", async () => {
    const fixture = await createColdCurrentSession();
    const { scope, original, archivePath } = fixture;
    const snapshot = () => ({
      rows: fixture.snapshot(),
      search: fixture
        .database()
        .prepare("SELECT * FROM session_transcript_fts ORDER BY message_id")
        .all(),
    });
    const archiveBytes = await fs.readFile(archivePath);
    const before = snapshot();
    expect(fixture.database().prepare("SELECT * FROM transcript_events").all()).toEqual([]);
    expect(
      fixture.database().prepare("SELECT current_session_id FROM session_nodes").all(),
    ).toEqual([{ current_session_id: scope.sessionId }]);
    const event = { type: "custom", id: "sync-custom", customType: "sync-write", data: {} };
    const message = { role: "user", content: "A new synchronous message", timestamp: 20 };
    const mutations = {
      "append event": () => appendTranscriptEventSync(scope, event),
      "append event snapshot": () => appendTranscriptEventSnapshotSync(scope, event),
      "append message": () => appendMessage(scope, { message, eventId: "sync-message" }),
      "append message snapshot": () =>
        appendTranscriptMessageSnapshotSync(scope, { message, eventId: "sync-message-snapshot" }),
      "replace transcript": () => replaceTranscriptEventsSync(scope, [event]),
      "replace full suffix": () => replaceSuffix(scope, original, original.slice(0, 1)),
      "replace incremental suffix": () =>
        replaceSuffix(scope, original.slice(1), [], 1, undefined, undefined, true),
    };
    for (const [name, run] of Object.entries(mutations)) {
      expect(run, name).toThrow(expect.objectContaining({ code: "TRANSCRIPT_COLD" }));
      expect(snapshot(), name).toEqual(before);
      expect(await fs.readFile(archivePath), name).toEqual(archiveBytes);
    }
  });

  it("restores and compacts with ID-selected authority without search preparation", async () => {
    const fixture = await createColdCurrentSession();
    const current = await captureSessionEntryCurrentCheckAsyncInternal(fixture.scope);
    try {
      await expect(createCompactAuthority(fixture).trim(current.source)).resolves.toEqual({
        compacted: true,
        kept: 3,
      });
      expect(coldDescriptor(fixture)).toBeUndefined();
      expect(loadTranscriptEventsSync(fixture.scope)).toHaveLength(3);
    } finally {
      current.release();
    }
  });

  it("refuses a denied manual compaction through SQL-free host preflight without restoring rows", async () => {
    const fixture = await createColdCurrentSession();
    const before = fixture.snapshot();
    const authority = createCompactAuthority(fixture, true);
    const sql = observeHostDataSql();
    try {
      await expect(authority.trim()).rejects.toThrow("Compaction source authority revoked");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(fixture.snapshot()).toEqual(before);
  });

  it("rechecks host authority after preparing a manual compaction source", async () => {
    const fixture = await createColdCurrentSession();
    const before = fixture.snapshot();
    const authority = createCompactAuthority(fixture);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = authority.source.prepareSessionSource!;
    authority.source.prepareSessionSource = async () => {
      const prepared = await prepare();
      entered.resolve();
      await release.promise;
      return prepared;
    };
    const pending = authority.trim();
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Compaction skipped source preparation",
      );
      authority.revoke();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
    await expect(pending).rejects.toThrow("Compaction source authority revoked");
    expect(fixture.snapshot()).toEqual(before);
  });

  it.each([
    ["before restoration read", 0, false],
    ["after host assertion", 0, false],
    ["after host assertion", 1, false],
    ["after host assertion", 0, true],
  ] as const)(
    "checks conversation alternatives %s (revoked=%s, both active=%s)",
    async (boundary, revoked, bothActive) => {
      const fixture = await createColdCurrentSession();
      const foreign = boundary === "after host assertion";
      const sourceScope = {
        ...fixture.scope,
        storePath: foreign
          ? path.join(path.dirname(fixture.scope.storePath), "source.sqlite")
          : fixture.scope.storePath,
      };
      if (foreign) {
        stores.push(sourceScope.storePath);
        await replaceSessionEntry(sourceScope, fixture.entry);
      }
      const sourceOptions = { agentId: sourceScope.agentId, path: sourceScope.storePath };
      const conversations = ["active", "inactive"].map((peerId) => {
        const identity = buildConversationIdentity({
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId,
          deliveryTarget: peerId,
        });
        if (!identity) {
          throw new Error("Expected a valid compaction conversation");
        }
        return identity;
      });
      const preparedConversations = conversations.map((identity) => ({
        identity,
        encoded: prepareConversationIdentities([identity]),
      }));
      runOpenClawAgentWriteTransaction((database) => {
        for (const { identity, encoded } of preparedConversations) {
          upsertConversationIdentities(database, encoded, 1);
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
        errorMessage: "Compaction conversation authority revoked",
      });
      const source: SessionSourceAssertion = current.source;
      const before = fixture.snapshot();
      const archiveBefore = await fs.readFile(fixture.archivePath);
      let changed = false;
      let inCommitGrant = false;
      const revokeBinding = () => {
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
      if (foreign) {
        const prepare = source.prepareSessionSource!;
        source.prepareSessionSource = async () => {
          const prepared = await prepare();
          return {
            ...prepared,
            assertPreparedCurrent() {
              (prepared.assertPreparedCurrent ?? prepared.assertCurrent)();
              if (inCommitGrant && !changed) {
                revokeBinding();
              }
            },
          };
        };
      }
      interceptRestoration((params) => ({
        ...params,
        withWriteAdmission: (run, diagnostics) =>
          params.withWriteAdmission((refusal) => {
            if (!refusal && !foreign && !changed) {
              revokeBinding();
            }
            return run(refusal);
          }, diagnostics),
        onCommitRequest: (...args) => {
          inCommitGrant = true;
          try {
            params.onCommitRequest(...args);
          } finally {
            inCommitGrant = false;
          }
        },
      }));
      const compact = createCompactAuthority(fixture).trim(source);
      const survives = revoked === 1 || bothActive;
      if (survives) {
        await expect(compact).resolves.toEqual({ compacted: true, kept: 3 });
      } else {
        await expect(compact).rejects.toThrow("Compaction conversation authority revoked");
      }
      expect(changed).toBe(true);
      expect(
        resolveCurrentConversationSession(sourceScope, conversations[revoked]!.conversationRef),
      ).toBeUndefined();
      expect(
        resolveCurrentConversationSession(sourceScope, conversations[1 - revoked]!.conversationRef),
      ).toEqual({
        sessionKey: sourceScope.sessionKey,
        sessionId: sourceScope.sessionId,
      });
      if (survives) {
        expect(coldDescriptor(fixture)).toBeUndefined();
        expect(loadTranscriptEventsSync(fixture.scope).slice(1)).toMatchObject([
          { id: "alternate" },
          { id: "selection" },
        ]);
        return;
      }
      expect(coldDescriptor(fixture)).toEqual(fixture.descriptor);
      expect(fixture.snapshot()).toEqual(before);
      expect(await fs.readFile(fixture.archivePath)).toEqual(archiveBefore);
    },
  );

  it.each(["source", "lifecycle", "missing lifecycle"] as const)(
    "rechecks %s rows after cold restoration waits for write admission",
    async (change) => {
      const fixture = await createColdCurrentSession();
      if (change === "missing lifecycle") {
        replaceSessionEntrySync(fixture.scope, {
          sessionId: fixture.entry.sessionId,
          updatedAt: fixture.entry.updatedAt,
        });
        expect(loadSessionEntry(fixture.scope)?.lifecycleRevision).toBeUndefined();
      }
      const authority = createCompactAuthority(
        fixture,
        false,
        change === "missing lifecycle" ? {} : fixture.entry,
      );
      let before = fixture.snapshot();
      let changed = false;
      interceptRestoration((params) => ({
        ...params,
        withWriteAdmission: (run, diagnostics) =>
          params.withWriteAdmission((refusal) => {
            if (!refusal) {
              replaceSessionEntrySync(fixture.scope, {
                ...fixture.entry,
                ...(change === "source"
                  ? { label: "revoked grant" }
                  : { lifecycleRevision: "successor" }),
              });
              changed = true;
              before = fixture.snapshot();
            }
            return run(refusal);
          }, diagnostics),
      }));
      await expect(authority.trim()).rejects.toThrow(
        change === "source"
          ? "Compaction source authority revoked"
          : /Session changed before cold transcript restoration/,
      );
      expect(changed).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
    },
  );

  it("rolls back restoration when prepared authority is revoked at commit", async () => {
    const fixture = await createColdCurrentSession();
    const before = fixture.snapshot();
    const authority = createCompactAuthority(fixture);
    const commit = observeCommit(authority.revoke);
    await expect(authority.trim()).rejects.toThrow("Compaction source authority revoked");
    expect(commit.requested).toBe(true);
    expect(fixture.snapshot()).toEqual(before);
  });

  it.each(["foreign row", "alias path"])(
    "rolls back restoration when a %s changes at the commit grant",
    async (change) => {
      const fixture = await createColdCurrentSession();
      const before = fixture.snapshot();
      const archiveBefore = await fs.readFile(fixture.archivePath);
      const sourceScope = {
        ...fixture.scope,
        storePath: path.join(tempDirs.make("openclaw-compact-source-"), "openclaw-agent.sqlite"),
      };
      stores.push(sourceScope.storePath);
      const sourceEntry = fixture.entry;
      if (change === "alias path") {
        symlinkSync(fixture.scope.storePath, sourceScope.storePath);
      } else {
        await replaceSessionEntry(sourceScope, sourceEntry);
      }
      const foreign = createCompactAuthority({ scope: sourceScope, entry: sourceEntry });
      let changed = false;
      interceptRestoration((params) => ({
        ...params,
        onCommitRequest: () => {
          if (change === "alias path") {
            unlinkSync(sourceScope.storePath);
            symlinkSync(seed!.snapshotPath, sourceScope.storePath);
          } else {
            replaceSessionEntrySync(sourceScope, { ...sourceEntry, label: "revoked grant" });
          }
          changed = true;
          params.onCommitRequest();
        },
      }));
      await expect(createCompactAuthority(fixture).trim(foreign.source)).rejects.toThrow(
        "Compaction source authority revoked",
      );
      expect(changed).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
      expect(await fs.readFile(fixture.archivePath)).toEqual(archiveBefore);
    },
  );

  it("restores and trims cold history with prepared authority", async () => {
    const fixture = await createColdCurrentSession();
    const authority = createCompactAuthority(fixture);
    await expect(authority.trim()).resolves.toEqual({ compacted: true, kept: 3 });
    expect(coldDescriptor(fixture)).toBeUndefined();
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual([
      fixture.original[0],
      {
        type: "message",
        id: "alternate",
        parentId: null,
        message: { role: "assistant", content: "Alternate answer" },
      },
      {
        type: "leaf",
        id: "selection",
        parentId: "alternate",
        targetId: null,
        appendParentId: null,
      },
    ]);
  });

  it.each(actions)("restores exact history before %s", async (action) => {
    const fixture = await createColdCurrentSession();
    const result = await runAction(action, fixture);
    if (action === "reset" || action === "batched reset") {
      expect(result).toMatchObject({ sessionId: "reset-next" });
    } else if (action === "fork" || action === "rewind") {
      expect(result).toMatchObject({ status: "created", editorText: "Question" });
    } else if (action === "branch list") {
      expect(result).toMatchObject({
        status: "ok",
        branches: expect.arrayContaining([
          expect.objectContaining({ leafEntryId: "answer", active: true }),
          expect.objectContaining({ leafEntryId: "alternate", active: false }),
        ]),
      });
    } else {
      expect(result).toMatchObject({
        status:
          action === "parent entry fork"
            ? "forked"
            : action === "parent decision"
              ? "fork"
              : "created",
      });
    }
    expect(coldDescriptor(fixture)).toBeUndefined();
    expect(loadTranscriptEventsSync(fixture.scope).slice(0, fixture.original.length)).toEqual(
      fixture.original,
    );
  });

  it("keeps an existing child skip independent of a missing parent archive", async () => {
    const fixture = await createColdCurrentSession();
    const childKey = "agent:main:existing-child";
    const childEntry = { sessionId: "existing-child", updatedAt: 2 };
    await applySessionEntryOperation(
      { ...fixture.scope, sessionKey: childKey },
      { kind: "fields", patch: childEntry },
      { fallbackEntry: childEntry, replaceEntry: true, skipMaintenance: true },
    );
    await fs.unlink(fixture.archivePath);
    const before = fixture.snapshot();
    await expect(
      forkSessionEntryFromParentTargetWithPatch(
        {
          agentId: fixture.scope.agentId,
          storePath: fixture.scope.storePath,
          parentTarget: fixture.target,
          sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
        },
        { skipExisting: true },
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "existing-entry",
      sessionEntry: { sessionId: "existing-child" },
    });
    expect(fixture.snapshot()).toEqual(before);
  });

  // Message cuts and parent transcript forks restore before dispatching their mutation modes.
  it.each(actions.filter((action) => !["rewind", "branch switch", "parent fork"].includes(action)))(
    "refuses %s without changing state when its archive is missing",
    async (action) => {
      const fixture = await createColdCurrentSession();
      const before = fixture.snapshot();
      await fs.unlink(fixture.archivePath);
      if (action === "branch list") {
        await expect(runAction(action, fixture)).resolves.toEqual({ status: "failed" });
      } else {
        await expect(runAction(action, fixture)).rejects.toThrow();
      }
      expect(fixture.snapshot()).toEqual(before);
      expect(coldDescriptor(fixture)).toEqual(fixture.descriptor);
    },
  );
});
