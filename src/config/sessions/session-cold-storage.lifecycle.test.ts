import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  forkSessionAtMessage,
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceTranscriptEvents,
  resetSessionEntryLifecycle,
  resolveSessionParentForkDecision,
  rewindSessionToMessage,
  switchSessionBranch,
} from "./session-accessor.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const tempDirs = createTempDirTracker();
const stores: string[] = [];
afterEach(async () => {
  for (const storePath of stores.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: storePath });
  }
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

async function createColdCurrentSession() {
  const storePath = path.join(tempDirs.make("openclaw-cold-lifecycle-"), "openclaw-agent.sqlite");
  stores.push(storePath);
  const scope = {
    agentId: "main",
    storePath,
    sessionId: "cold-current",
    sessionKey: "agent:main:cold-lifecycle",
  };
  const entry = { sessionId: scope.sessionId, updatedAt: 1, lifecycleRevision: "cold-revision" };
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
  const options = { agentId: scope.agentId, path: storePath };
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
  const original = loadTranscriptEventsSync(scope);
  await expect(
    runSessionColdStorageMaintenance({
      config: {
        agents: { list: [{ id: "main" }] },
        session: {
          store: storePath,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      },
    }),
  ).resolves.toMatchObject({ archivedTranscripts: 1 });
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
      forkSessionEntryFromParentTarget({
        agentId: fixture.scope.agentId,
        storePath: fixture.scope.storePath,
        parentTarget: fixture.target,
        sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
        skipForkWhen: (entry) => entry.sessionId === "existing-child",
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "existing-entry",
      sessionEntry: { sessionId: "existing-child" },
    });
    expect(fixture.snapshot()).toEqual(before);
  });

  it.each(actions)(
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
