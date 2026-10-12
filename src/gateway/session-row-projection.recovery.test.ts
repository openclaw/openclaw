import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

afterEach(() => vi.restoreAllMocks());

it("refreshes omitted cold previews after a history read without revoking sharing", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:cold-preview",
      sessionId: "cold-preview",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      visibility: "shared",
      updatedAt: Date.now(),
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { message: { role: "user", content: "Remember the restored conversation" } },
        { message: { role: "assistant", content: "I will remember it." } },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 86_400_000);
    await expect(
      runSessionColdStorageMaintenance({
        config: {
          ...cfg,
          session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } },
        },
      }),
    ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    clock.mockRestore();
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const originalEntry = loadSessionEntry(scope);
    const context = requestContext(cfg);
    const client = identifiedClient("viewer@example.com");
    const request = { includeLastMessage: true };
    const omitted = observeSessionRowBackfill([scope.sessionKey]);
    try {
      await listSessions({ context, client, request });
      await withinTest(omitted, signal);
      const projection = getSessionRowProjection(context)!;
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      const before = await listSessions({ context, client, request });
      expect(before.sessions).toEqual([
        expect.objectContaining({ key: scope.sessionKey, sharingRole: "viewer" }),
      ]);
      expect(before.sessions[0]?.lastMessagePreview).toBeUndefined();
      expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
      const sharingEntry = projection.capture(query)?.sharingEntry;
      const refreshed = observeSessionRowBackfill([scope.sessionKey], projection);
      const history = await readSessionMessagesPageWithStatsAsync(scope, {
        maxMessages: 100,
        offset: 0,
      });
      expect(history.messages).toEqual([
        expect.objectContaining({ role: "user", content: "Remember the restored conversation" }),
        expect.objectContaining({ role: "assistant", content: "I will remember it." }),
      ]);
      expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeUndefined();
      expect(projection.capture(query)?.sharingEntry).toEqual(sharingEntry);
      await withinTest(refreshed, signal);
      const after = await listSessions({ context, client, request });
      expect(after.sessions).toEqual([
        expect.objectContaining({
          key: scope.sessionKey,
          sharingRole: "viewer",
          lastMessagePreview: "I will remember it.",
        }),
      ]);
      expect(loadSessionEntry(scope)).toEqual(originalEntry);
    } finally {
      getSessionRowProjection(context)?.dispose();
    }
  });
  onTestFinished(() => run);
  return run;
});

it("keeps projection reads outside borrowed startup admission and admits completed recovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: {}, worker: {} },
        defaults: { sessionStore: { agentId: "main" } },
      },
    };
    const query = { agentId: "worker", key: "agent:worker:recovering" };
    const unaffected = { agentId: "main", key: "agent:main:unchanged" };
    replaceSessionEntrySync(
      { agentId: unaffected.agentId, sessionKey: unaffected.key },
      { sessionId: "unchanged", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key },
      { sessionId: "recovering", updatedAt: 1 },
    );
    const path = resolveOpenClawAgentSqlitePath({ agentId: query.agentId });
    closeOpenClawAgentDatabaseByPath(path, query.agentId);
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: query.agentId,
      paths: [path],
      pending: true,
      reason: "Startup preparation is still pending",
    });
    recordAgentDatabaseAdmissions([refusal], { source: "startup" });
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.snapshot(query).row).toBeNull();
      let beforeRecovery = 0;
      await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {
        sessionChanges.emit({ all: true, scope: "config" });
        expect(projection.capture(query)).toBeUndefined();
        await projection.ensureMaterialized();
        expect(projection.snapshot(query).row).toBeNull();
        expect(listOpenClawAgentDatabasesForTest().some((db) => db.path === path)).toBe(false);
        beforeRecovery = projection.materializedCount;
      });
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row?.sessionId).toBe("recovering");
      expect(projection.snapshot(unaffected).row?.sessionId).toBe("unchanged");
      expect(projection.materializedCount - beforeRecovery).toBe(1);
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes previews after reconciliation without metadata mutation or clean-read SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:recovered-title",
      sessionId: "recovered-title",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      visibility: "shared",
      updatedAt: Date.now(),
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { message: { role: "user", content: "Explain the recovered session" } },
        { message: { role: "assistant", content: "The existing reply is available again." } },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const events = database.db.prepare(
      "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
    );
    const originalEvents = events.all(scope.sessionId);
    const originalEntry = loadSessionEntry(scope);
    const context = requestContext(cfg);
    const client = identifiedClient("owner@example.com");
    const options = { includeDerivedTitles: true, includeLastMessage: true };
    // Model the optional reader's unavailable result without racing automatic reconciliation.
    const previewRead = vi
      .spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields")
      .mockResolvedValue({});
    const transcriptUpdates = vi.fn();
    const stop = onInternalSessionTranscriptUpdate(transcriptUpdates);
    try {
      const initial = await listSessions({ context, client, request: options });
      expect(initial.sessions.map((row) => row.key)).toEqual([scope.sessionKey]);
      expect(initial.sessions[0]?.derivedTitle).toBeUndefined();
      expect(initial.sessions[0]?.lastMessagePreview).toBeUndefined();
      await vi.waitFor(() => expect(previewRead).toHaveBeenCalled());
      previewRead.mockRestore();
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(scope.sessionId);
      await expect(
        reconcileSessionTranscriptIndexes({ agentId: scope.agentId, path: database.path }),
      ).resolves.toEqual({ reconciledSessions: 1 });
      const projection = getSessionRowProjection(context)!;
      await projection.ensureMaterialized();
      expect(transcriptUpdates).not.toHaveBeenCalled();
      expect(events.all(scope.sessionId)).toEqual(originalEvents);

      const expected = {
        key: scope.sessionKey,
        derivedTitle: undefined,
        lastMessagePreview: "The existing reply is available again.",
      };
      await vi.waitFor(() =>
        expect(
          projection.snapshot({ agentId: scope.agentId, key: scope.sessionKey }, options).row,
        ).toMatchObject(expected),
      );
      expect(loadSessionEntry(scope)).toEqual(originalEntry);
      const nativeCalls = observeMainThreadSql();
      const healed = await listSessions({ context, client, request: options });
      expect(healed.sessions).toEqual([
        expect.objectContaining({
          key: expected.key,
          lastMessagePreview: expected.lastMessagePreview,
        }),
      ]);
      expect(healed.sessions[0]?.derivedTitle).toBeUndefined();
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "recovered-describe", method: "sessions.describe" },
        params: { key: scope.sessionKey, ...options },
        context,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        session: expect.objectContaining(expected),
      });
      expect(
        projection.snapshot({ agentId: scope.agentId, key: scope.sessionKey }, options).row,
      ).toMatchObject(expected);
      nativeCalls.expectIdle();
    } finally {
      stop();
      getSessionRowProjection(context)?.dispose();
      vi.restoreAllMocks();
    }
  });
});
