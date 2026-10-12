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
import { captureGatewayToolReceiptAssertion } from "../../agents/tools/gateway-caller-context.js";
import { readGatewayRequestMutationAuthority } from "../../gateway/server-methods/session-mutation-guards.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import { composeSessionTranscriptWriteAssertion } from "../../plugin-sdk/session-transcript-runtime.js";
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
  applySessionEntryLifecycleMutation,
  forkSessionAtMessage,
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceSessionEntrySync,
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
import { forkSessionEntryFromParentTargetWithPatch } from "./session-accessor.sqlite-parent-session.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { trimSessionTranscriptForManualCompact } from "./session-accessor.transcript.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import { captureSessionEntryCurrentCheckInternal } from "./session-entry-current-check.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { createManualCompactRecords } from "./transcript-message.test-support.js";
import type { SessionEntry } from "./types.js";

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
        config: {
          agents: { entries: { main: {} } },
          session: {
            store: storePath,
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
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

it.each([
  {
    change: "lifecycle rebound",
    selectedRevision: "selected",
    patch: { lifecycleRevision: "successor" },
  },
  {
    change: "missing lifecycle rebound",
    selectedRevision: undefined,
    patch: { lifecycleRevision: "successor" },
  },
  {
    change: "archived",
    selectedRevision: "selected",
    patch: { archivedAt: 1 },
  },
  {
    change: "initialization pending",
    selectedRevision: "selected",
    patch: { initializationPending: true },
  },
] satisfies {
  change: string;
  selectedRevision: string | undefined;
  patch: Partial<SessionEntry>;
}[])("refuses native incognito compaction after $change", async ({ selectedRevision, patch }) => {
  const agentId = "main";
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-incognito-compact-authority-") };
  const scope = {
    agentId,
    env,
    sessionId: "incognito-manual-compact",
    sessionKey: "agent:main:dashboard:incognito-manual-compact",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  };
  stores.push(scope.storePath);
  const initialEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: selectedRevision,
    incognito: true as const,
    updatedAt: Date.now(),
  };
  await replaceSessionEntry(scope, initialEntry);
  const records = createManualCompactRecords(scope.sessionId);
  await replaceTranscriptEvents(scope, records);
  replaceSessionEntrySync(scope, { ...initialEntry, ...patch });
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

  expect(loadTranscriptEventsSync(scope)).toEqual(records);
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

const compactSourceModes = ["prepared", "opaque sibling", "SDK wrapper", "SDK transport"] as const;

function composeCompactSource(
  source: SessionSourceAssertion,
  fixture: Fixture,
  mode: (typeof compactSourceModes)[number],
  inCommitGrant: () => boolean,
) {
  const opaque = vi.fn(() => {
    if (inCommitGrant()) {
      throw new Error("Opaque callback entered a restoration commit grant");
    }
    expect(loadSessionEntry(fixture.scope)?.sessionId).toBe(fixture.scope.sessionId);
  });
  let composed = source;
  switch (mode) {
    case "prepared":
      break;
    case "opaque sibling":
      composed = captureGatewayToolReceiptAssertion(
        composeSessionSourceAssertion([source, captureExternalSessionCommitGuard(opaque)]),
      );
      break;
    case "SDK wrapper":
      composed = composeSessionTranscriptWriteAssertion([source], (assertSources) => {
        opaque();
        assertSources();
      });
      break;
    case "SDK transport":
      composed = composeSessionSourceAssertion([
        source,
        readGatewayRequestMutationAuthority({
          req: { type: "req", id: "compact-sdk-transport", method: "sessions.compact", params: {} },
          client: null,
          hasCurrentClientAuthority: () => {
            opaque();
            return true;
          },
        }).assertCurrent,
      ]);
      break;
  }
  return { source: composed, opaque };
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
    {
      name: "keeps cold history unchanged when conversation alternatives split before restoration read",
      boundary: "before restoration read",
      revoked: 0,
      bothActive: false,
    },
    {
      name: "keeps cold history unchanged when conversation alternatives split after host assertion",
      boundary: "after host assertion",
      revoked: 0,
      bothActive: false,
    },
    {
      name: "restores cold history when only the inactive conversation alternative changes",
      boundary: "after host assertion",
      revoked: 1,
      bothActive: false,
    },
    {
      name: "restores cold history when another active conversation alternative survives",
      boundary: "after host assertion",
      revoked: 0,
      bothActive: true,
    },
  ] as const)("$name", async ({ boundary, revoked, bothActive }) => {
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
    const current = await captureSessionEntryCurrentCheckInternal({
      ...sourceScope,
      alternatives: conversations.map((identity, index) => ({
        conversations: [{ ...identity, sessionKey: sourceScope.sessionKey }],
        isActive: () => index === 0 || bothActive,
      })),
      errorMessage: "Compaction conversation authority revoked",
    });
    const source: SessionSourceAssertion = current.assertCurrent;
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
          assertCurrent() {
            prepared.assertCurrent();
            if (inCommitGrant && !changed) {
              revokeBinding();
            }
          },
        };
      };
    }
    const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      (params) => {
        if (params.expectedMessageType !== "reclaimed") {
          return original(params);
        }
        return original({
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
        });
      },
    );
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
      expect(
        readSessionColdTranscript(fixture.database(), fixture.scope.sessionId),
      ).toBeUndefined();
      expect(loadTranscriptEventsSync(fixture.scope).slice(1)).toMatchObject([
        { id: "alternate" },
        { id: "selection" },
      ]);
      return;
    }
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toEqual(
      fixture.descriptor,
    );
    expect(fixture.snapshot()).toEqual(before);
    expect(await fs.readFile(fixture.archivePath)).toEqual(archiveBefore);
  });

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
      const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
        (params) => {
          if (params.expectedMessageType !== "reclaimed") {
            return original(params);
          }
          return original({
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
          });
        },
      );
      await expect(authority.trim()).rejects.toThrow(
        change === "source"
          ? "Compaction source authority revoked"
          : /Session changed before cold transcript restoration/,
      );
      expect(changed).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
    },
  );

  it.each(compactSourceModes)(
    "rolls back restoration when %s authority is revoked at commit",
    async (mode) => {
      const fixture = await createColdCurrentSession();
      const before = fixture.snapshot();
      const authority = createCompactAuthority(fixture);
      let commitRequested = false;
      let inCommitGrant = false;
      const mixed = composeCompactSource(authority.source, fixture, mode, () => inCommitGrant);
      const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
        (params) => {
          if (params.expectedMessageType !== "reclaimed") {
            return original(params);
          }
          return original({
            ...params,
            onCommitRequest: () => {
              commitRequested = true;
              authority.revoke();
              inCommitGrant = true;
              try {
                params.onCommitRequest();
              } finally {
                inCommitGrant = false;
              }
            },
          });
        },
      );
      await expect(authority.trim(mixed.source)).rejects.toThrow(
        "Compaction source authority revoked",
      );
      expect(commitRequested).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
    },
  );

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
      const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
        (params) => {
          if (params.expectedMessageType !== "reclaimed") {
            return original(params);
          }
          return original({
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
          });
        },
      );
      await expect(createCompactAuthority(fixture).trim(foreign.source)).rejects.toThrow(
        "Compaction source authority revoked",
      );
      expect(changed).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
      expect(await fs.readFile(fixture.archivePath)).toEqual(archiveBefore);
    },
  );

  it.each(compactSourceModes)(
    "restores and trims cold history with authorized %s authority",
    async (mode) => {
      const fixture = await createColdCurrentSession();
      const authority = createCompactAuthority(fixture);
      let inCommitGrant = false;
      const mixed = composeCompactSource(authority.source, fixture, mode, () => inCommitGrant);
      const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
        (params) => {
          if (params.expectedMessageType !== "reclaimed") {
            return original(params);
          }
          return original({
            ...params,
            onCommitRequest: () => {
              inCommitGrant = true;
              try {
                params.onCommitRequest();
              } finally {
                inCommitGrant = false;
              }
            },
          });
        },
      );
      await expect(authority.trim(mixed.source)).resolves.toEqual({
        compacted: true,
        kept: 3,
      });
      if (mode !== "prepared") {
        expect(mixed.opaque).toHaveBeenCalled();
      }
      expect(
        readSessionColdTranscript(fixture.database(), fixture.scope.sessionId),
      ).toBeUndefined();
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
    },
  );

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
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeUndefined();
    expect(loadTranscriptEventsSync(fixture.scope).slice(0, fixture.original.length)).toEqual(
      fixture.original,
    );
  });

  it("keeps an existing child skip independent of a missing parent archive", async () => {
    const fixture = await createColdCurrentSession();
    const childKey = "agent:main:existing-child";
    await replaceSessionEntry(
      { ...fixture.scope, sessionKey: childKey },
      { sessionId: "existing-child", updatedAt: 2 },
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
      expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toEqual(
        fixture.descriptor,
      );
    },
  );
});
