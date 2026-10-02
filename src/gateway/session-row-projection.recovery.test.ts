import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
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
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => vi.restoreAllMocks());

it.each(["background", "capture"] as const)(
  "keeps %s projection reads outside borrowed startup admission and admits completed recovery",
  async (read) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { list: [{ id: "main", default: true }, { id: "worker" }] } };
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
          if (read === "capture") {
            expect(projection.capture(query)).toBeUndefined();
          }
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
  },
);

it("refreshes previews after reconciliation without metadata mutation or clean-read SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
      expect(initial.sessions).toEqual([
        expect.objectContaining({
          key: scope.sessionKey,
          derivedTitle: undefined,
          lastMessagePreview: undefined,
        }),
      ]);
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
      expect(healed.sessions).toEqual([expect.objectContaining(expected)]);
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

it("captures the committed replacement before background materialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const query = { agentId: "main", key: "agent:main:replaced" };
    const target = { agentId: query.agentId, sessionKey: query.key };
    replaceSessionEntrySync(target, { sessionId: "previous", updatedAt: 1 });
    const projection = await createSessionRowProjection({ cfg });
    try {
      const previous = projection.capture(query)!;
      replaceSessionEntrySync(target, { sessionId: "current", updatedAt: 2 });
      const captured = projection.capture(query)!;
      expect(captured.entry?.sessionId).toBe("current");
      await projection.ensureMaterialized();
      expect(projection.isCurrent(captured)).toBe(true);
      expect(projection.isCurrent(previous)).toBe(false);
    } finally {
      projection.dispose();
    }
  });
});
