import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionEntryWithTranscript } from "./session-accessor.entry-mutation.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { readActiveTranscriptEntryAnchorFromProjection } from "./session-accessor.sqlite-transcript-anchor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import {
  readActiveTranscriptEntryAnchorAsync,
  readSessionTranscriptAnchorsAsync,
} from "./session-transcript-anchor-read.js";
import * as anchorKernel from "./session-transcript-anchor-read.kernel.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

const events = [
  { type: "session", id: "anchors", version: 3 },
  {
    type: "message",
    id: "question",
    parentId: null,
    message: { role: "user", content: "question", idempotencyKey: "question-key" },
  },
  {
    type: "message",
    id: "answer",
    parentId: "question",
    message: { role: "assistant", content: "answer", __openclaw: { runId: "answer-run" } },
  },
  {
    type: "message",
    id: "alternate",
    parentId: "question",
    message: { role: "assistant", content: "other branch" },
  },
  { type: "leaf", id: "selected-leaf", parentId: "alternate", targetId: "answer" },
];

function transcriptScope(state: OpenClawTestState) {
  return {
    agentId: "main",
    env: state.env,
    sessionId: "anchors",
    sessionKey: "agent:main:anchors",
    storePath: state.statePath("transcript.sqlite"),
  };
}

it("keeps replay tails metadata-only unless message payloads are selected", async () => {
  await withOpenClawTestState({ label: "transcript-tail-payload-selection" }, async (state) => {
    const scope = transcriptScope(state);
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
    }));
    await replaceTranscriptEvents(scope, [
      ...events.slice(0, 2),
      {
        type: "message",
        id: "untagged",
        parentId: "question",
        message: { role: "assistant", content: "metadata-only answer" },
      },
      {
        type: "message",
        id: "tagged",
        parentId: "untagged",
        message: {
          role: "assistant",
          content: "selected answer",
          __openclaw: { runId: "tail-run" },
        },
      },
    ]);
    const selection = {
      entryIds: ["question"],
      afterSeq: 1,
      replayValidation: { allowInitial: false },
    };
    const metadata = await readSessionTranscriptAnchorsAsync(scope, selection);
    expect(metadata.replayValidated).toBe("current");
    expect(metadata.tail?.entries).toEqual([
      { entryId: "untagged", role: "assistant" },
      { entryId: "tagged", role: "assistant", runId: "tail-run" },
    ]);
    const selected = await readSessionTranscriptAnchorsAsync(scope, {
      ...selection,
      includeMessagesForRunId: "tail-run",
    });
    expect(selected.tail?.entries[0]).toEqual({ entryId: "untagged", role: "assistant" });
    expect(selected.tail?.entries[1]).toMatchObject({
      entryId: "tagged",
      anchor: { entryId: "tagged" },
      message: { role: "assistant", content: "selected answer" },
    });
  });
});

it("rejects an async anchor consumer on the selected execution owner", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-async-consumer" }, async (state) => {
    const scope = transcriptScope(state);
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
    }));
    await replaceTranscriptEvents(scope, events);
    const { databaseClaim } = await loadSessionEntryForAdmission(scope);
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      throw new Error("Expected admitted durable session reader");
    }
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionReader: databaseClaim.reader,
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          let consumed = false;
          await expect(
            readSessionTranscriptAnchorsAsync(
              scope,
              { entryIds: ["question"] },
              undefined,
              // oxlint-disable-next-line typescript/no-misused-promises -- Exercise runtime rejection of an async consumer.
              async (facts) => {
                expect(facts.anchors).toMatchObject([{ entryId: "question" }]);
                consumed = true;
              },
            ),
          ).rejects.toThrow("must remain synchronous");
          expect(consumed).toBe(true);
        },
      );
    } finally {
      await databaseClaim.release();
    }
  });
});

it("reads active anchors and raw tail facts without caller SQL, including cold discovery", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-worker" }, async (state) => {
    const scope = transcriptScope(state);
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const absentPath = state.statePath("absent.sqlite");
    const hostSql = observeHostDataSql();
    try {
      const result = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: ["question", "answer", "alternate", "missing"],
        afterSeq: 1,
      });
      expect(result.anchors).toEqual([
        {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          generation: expect.any(String),
          entryId: "question",
          rawSeq: 1,
          effectiveParentId: null,
          activeMessagePosition: 0,
          idempotencyKey: "question-key",
        },
        {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          generation: expect.any(String),
          entryId: "answer",
          rawSeq: 2,
          effectiveParentId: "question",
          activeMessagePosition: 1,
        },
      ]);
      expect(result.anchors[0]?.generation).toBe(result.anchors[1]?.generation);
      expect(result.tail).toEqual({
        lastSeq: 4,
        entries: [
          { entryId: "answer", role: "assistant", runId: "answer-run", anchor: result.anchors[1] },
          { entryId: "alternate", role: "assistant" },
        ],
      });
      await expect(
        readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: "question" }),
      ).resolves.toEqual(result.anchors[0]);
      await expect(
        readSessionTranscriptAnchorsAsync(
          { ...scope, sessionId: "missing" },
          { entryIds: ["question"] },
        ),
      ).resolves.toEqual({ anchors: [] });
      await expect(
        readActiveTranscriptEntryAnchorAsync({
          ...scope,
          storePath: absentPath,
          entryId: "question",
        }),
      ).resolves.toBeUndefined();
      const consumeInitial = vi.fn();
      await expect(
        readSessionTranscriptAnchorsAsync(
          { ...scope, storePath: absentPath },
          { entryIds: [], replayValidation: { allowInitial: true } },
          undefined,
          consumeInitial,
        ),
      ).resolves.toEqual({ anchors: [], replayValidated: "initial" });
      expect(consumeInitial).toHaveBeenCalledWith({ anchors: [], replayValidated: "initial" });
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    await expect(fs.stat(absentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each([
  "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
  "UPDATE session_transcript_index_state SET indexed_seq = indexed_seq - 1 WHERE session_id = ?",
  "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
])("refuses stale projection anchors without rebuilding: %s", async (invalidate) => {
  await withOpenClawTestState({ label: "transcript-anchors-stale" }, async (state) => {
    const scope = transcriptScope(state);
    await replaceTranscriptEvents(scope, events);
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      env: scope.env,
      path: scope.storePath,
    });
    database.db.prepare(invalidate).run(scope.sessionId);
    const version = database.db.prepare("PRAGMA data_version");
    const before = version.get();
    const hostSql = observeHostDataSql();
    try {
      const result = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: ["question", "answer"],
        afterSeq: 0,
      });
      expect(result.anchors).toEqual([]);
      expect(result.tail?.entries.every((entry) => entry.anchor === undefined)).toBe(true);
      await expect(
        readSessionTranscriptAnchorsAsync(scope, {
          entryIds: ["question", "answer"],
          afterSeq: 0,
          includeMessagesForRunId: "answer-run",
        }),
      ).rejects.toMatchObject({
        name: "SessionTranscriptProjectionUnavailableError",
        sessionId: scope.sessionId,
        reason: "rebuilding",
      });
      const hydrate = prepareSessionTranscriptHydration(scope, { maxBytes: 4096, maxEvents: 10 });
      await expect(
        hydrate.readCohort!({ sessionKey: scope.sessionKey, entryIds: ["question"] }, () => {
          throw new Error("Stale hydration must not publish anchors");
        }),
      ).rejects.toMatchObject({
        name: "SessionTranscriptProjectionUnavailableError",
        sessionId: scope.sessionId,
        reason: "rebuilding",
      });
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    expect(version.get()).toEqual(before);
  });
});

it("borrows one ready projection for anchors and payloads without extending its source or snapshot", async () => {
  await withOpenClawTestState({ label: "transcript-anchor-projection-borrow" }, async (state) => {
    const scope = transcriptScope(state);
    await replaceTranscriptEvents(scope, events);
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      env: scope.env,
      path: scope.storePath,
    });
    const resolved = { ...scope, path: database.path };
    const selection = {
      entryIds: ["question", "answer"],
      afterSeq: 1,
      includeMessagesForRunId: "answer-run",
    };
    const readMessage = await anchorKernel.prepareSessionTranscriptAnchorMessageReader(selection);
    const peer = new DatabaseSync(database.path);
    const statements = trackSqliteStatementExecutions(database.db, ["readiness"], (sql) =>
      sql.includes('"session_transcript_index_state"') ? "readiness" : null,
    );
    let borrowed: CurrentTranscriptProjection | undefined;
    try {
      const result = readCurrentProjectionSnapshot(database, resolved, (projection) => {
        borrowed = projection;
        peer
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
        for (const target of [
          { ...resolved, sessionId: "another-transcript" },
          { ...resolved, sessionKey: "agent:main:another-key" },
          { ...resolved, agentId: "another-agent" },
        ]) {
          expect(() =>
            anchorKernel.readSessionTranscriptAnchorFactsInDatabase(
              database,
              target,
              selection,
              readMessage,
              projection,
            ),
          ).toThrow("differs from its selected session snapshot");
        }
        expect(() =>
          anchorKernel.readSessionTranscriptAnchorFactsInDatabase(
            { ...database, path: `${database.path}.replacement` },
            resolved,
            selection,
            readMessage,
            projection,
          ),
        ).toThrow("differs from its selected session snapshot");
        return anchorKernel.readSessionTranscriptAnchorFactsInDatabase(
          database,
          resolved,
          selection,
          readMessage,
          projection,
        );
      });
      expect(result).toMatchObject({
        kind: "value",
        value: {
          anchors: [
            { entryId: "question", rawSeq: 1 },
            { entryId: "answer", rawSeq: 2 },
          ],
          tail: {
            entries: [
              {
                entryId: "answer",
                message: { role: "assistant", content: "answer" },
                anchor: { entryId: "answer", activeMessagePosition: 1 },
              },
              { entryId: "alternate", role: "assistant" },
            ],
          },
        },
      });
      expect(statements.counts.readiness).toBe(1);
      expect(borrowed).toBeDefined();
      expect(() => readActiveTranscriptEntryAnchorFromProjection(borrowed!, "question")).toThrow(
        "requires its selected session snapshot",
      );
      expect(() =>
        anchorKernel.readSessionTranscriptAnchorFactsInDatabase(
          database,
          resolved,
          selection,
          readMessage,
        ),
      ).toThrow("projection is rebuilding");
    } finally {
      statements.restore();
      peer.close();
    }
  });
});

it("rejects a physical replacement while target discovery is suspended", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-replaced" }, async (state) => {
    const scope = transcriptScope(state);
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const held = createDeferred();
    const release = createDeferred();
    const resolve = targetWorker.resolveSessionSqliteTargetInWorker;
    const observation = vi
      .spyOn(targetWorker, "resolveSessionSqliteTargetInWorker")
      .mockImplementation(async (...args) => {
        const result = await resolve(...args);
        held.resolve();
        await release.promise;
        return result;
      });
    const pending = readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: "question" });
    try {
      await awaitGateBeforeSettlement(
        held.promise,
        pending,
        "Anchor read settled without awaiting target discovery",
      );
      const originalPath = state.statePath("original.sqlite");
      await fs.rename(scope.storePath, originalPath);
      await fs.copyFile(originalPath, scope.storePath);
      release.resolve();
      await expect(pending).rejects.toThrow("captured database owner");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      observation.mockRestore();
    }
  });
});

it("joins the retained anchor reader when closing its original logical store path", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-alias-close" }, async (state) => {
    const scope = { ...transcriptScope(state), storePath: state.statePath("custom.sqlite") };
    const requestedPath = state.statePath("custom.json");
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    await expect(
      readActiveTranscriptEntryAnchorAsync({
        ...scope,
        storePath: requestedPath,
        entryId: "question",
      }),
    ).resolves.toMatchObject({ entryId: "question", storePath: scope.storePath });

    const claimSoleCustody = () => {
      const raw = new DatabaseSync(scope.storePath);
      try {
        // A retained WAL connection prevents sole custody even between read transactions.
        raw.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
      } finally {
        raw.close();
      }
    };
    expect(claimSoleCustody).toThrow(/database is locked/);
    await closeOpenClawAgentDatabaseByPathAsync(requestedPath, scope.agentId);
    expect(claimSoleCustody).not.toThrow();
  });
});

it("keeps incognito anchors with their native owner without creating durable state", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-incognito" }, async (state) => {
    const scope = {
      ...transcriptScope(state),
      sessionKey: "agent:main:dashboard:incognito-anchors",
    };
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
    }));
    await replaceTranscriptEvents(scope, events);
    await expect(
      readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: "question" }),
    ).resolves.toMatchObject({ entryId: "question", rawSeq: 1 });
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
    await closeOpenClawAgentDatabasesAsync(state.root);
    await expect(
      readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: "question" }),
    ).resolves.toBeUndefined();
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
  });
});

it("rejects native owner replacement while display policy is preparing", async () => {
  await withOpenClawTestState({ label: "transcript-native-anchors-replaced" }, async (state) => {
    const scope = {
      ...transcriptScope(state),
      sessionKey: "agent:main:dashboard:incognito-anchors",
    };
    const initialize = async () => {
      await createSessionEntryWithTranscript(scope, () => ({
        ok: true,
        entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
      }));
      await replaceTranscriptEvents(scope, events);
    };
    await initialize();
    const held = createDeferred();
    const release = createDeferred();
    const prepare = anchorKernel.prepareSessionTranscriptAnchorMessageReader;
    const observation = vi
      .spyOn(anchorKernel, "prepareSessionTranscriptAnchorMessageReader")
      .mockImplementation(async (selection) => {
        held.resolve();
        await release.promise;
        return prepare(selection);
      });
    const pending = readSessionTranscriptAnchorsAsync(scope, {
      entryIds: ["question"],
      afterSeq: 1,
      includeMessagesForRunId: "answer-run",
    });
    try {
      await awaitGateBeforeSettlement(held.promise, pending, "Display policy was not prepared");
      await closeOpenClawAgentDatabasesAsync(state.root);
      await initialize();
      release.resolve();
      await expect(pending).rejects.toThrow("captured native database owner");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      observation.mockRestore();
    }
  });
});
