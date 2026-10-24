import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import * as indexes from "../config/sessions/session-transcript-reconcile.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import * as admission from "../state/agent-database-admission.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import * as reads from "./server-methods/sessions-read-cache.test-support.js";
import * as backfill from "./session-row-backfill.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import * as rows from "./session-row-projection.read-fixture.test-support.js";
import {
  appendProjectionMessages,
  seedProjectionRow,
} from "./session-row-projection.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

afterEach(() => vi.restoreAllMocks());

const messages = [
  { role: "user", content: "Recovered question" },
  { role: "assistant", content: "Recovered answer" },
];
it.for(["cold storage", "index reconciliation"] as const)(
  "restores previews after %s without mutating metadata",
  (mode, { signal, onTestFinished }) => {
    const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cold = mode === "cold storage";
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:recovered", sessionId: "recovered" };
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      await sessions.upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        visibility: "shared",
        updatedAt: Date.now(),
      });
      await appendProjectionMessages(scope, ...messages);
      await indexes.waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
      if (cold) {
        using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 86_400_000);
        await expect(
          runSessionColdStorageMaintenance({
            config: {
              ...cfg,
              session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } },
            },
          }),
        ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      } else {
        backfill.clearStoredSessionRowTranscriptForTest(scope);
      }
      const database = agentDb.openOpenClawAgentDatabase(scope);
      const originalEntry = sessions.loadSessionEntry(scope);
      const events = database.db.prepare(
        "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
      );
      const originalEvents = events.all(scope.sessionId);
      const context = reads.requestContext(cfg),
        client = reads.identifiedClient("viewer@example.com");
      const options = {
        includeLastMessage: true,
        ...(!cold ? { includeDerivedTitles: true } : {}),
      };
      const list = () => reads.listSessions({ context, client, request: options });
      using cleanup = new DisposableStack();
      cleanup.defer(() => getSessionRowProjection(context)?.dispose());
      const transcriptUpdates = vi.fn();
      cleanup.defer(onInternalSessionTranscriptUpdate(transcriptUpdates));
      const omitted = cold ? backfill.observeSessionRowBackfill([scope.sessionKey]) : undefined;
      // Prevent automatic reconciliation from racing the unavailable-reader fixture.
      const previewRead = cold
        ? undefined
        : vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockResolvedValue({});
      let initial = await list();
      if (cold) {
        await withinTest(omitted!, signal);
        initial = await list();
        expect(initial.sessions).toEqual([
          expect.objectContaining({ key: scope.sessionKey, sharingRole: "viewer" }),
        ]);
        expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
      } else {
        expect(initial.sessions.map((row) => row.key)).toEqual([scope.sessionKey]);
        expect(initial.sessions[0]?.derivedTitle).toBeUndefined();
        await vi.waitFor(() => expect(previewRead).toHaveBeenCalled());
        previewRead!.mockRestore();
      }
      expect(initial.sessions[0]?.lastMessagePreview).toBeUndefined();
      const projection = getSessionRowProjection(context)!;
      const sharingEntry = projection.capture(query)?.sharingEntry;
      if (cold) {
        const refreshed = backfill.observeSessionRowBackfill([scope.sessionKey], projection);
        const history = await readSessionMessagesPageWithStatsAsync(scope, {
          maxMessages: 100,
          offset: 0,
        });
        expect(history.messages).toEqual(
          messages.map((message) => expect.objectContaining(message)),
        );
        expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeUndefined();
        expect(projection.capture(query)?.sharingEntry).toEqual(sharingEntry);
        await withinTest(refreshed, signal);
      } else {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
        await expect(
          indexes.reconcileSessionTranscriptIndexes({
            agentId: scope.agentId,
            path: database.path,
          }),
        ).resolves.toEqual({ reconciledSessions: 1 });
        await projection.ensureMaterialized();
        expect(transcriptUpdates).not.toHaveBeenCalled();
        expect(events.all(scope.sessionId)).toEqual(originalEvents);
      }
      const expected = { key: scope.sessionKey, lastMessagePreview: "Recovered answer" };
      if (!cold) {
        await vi.waitFor(() =>
          expect(projection.snapshot(query, options).row).toMatchObject(expected),
        );
      }
      expect(sessions.loadSessionEntry(scope)).toEqual(originalEntry);
      const nativeCalls = cold ? undefined : observeMainThreadSql();
      const healed = await list();
      expect(healed.sessions).toEqual([
        expect.objectContaining({
          ...expected,
          ...(cold ? { sharingRole: "viewer" } : {}),
        }),
      ]);
      if (!cold) {
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
        expect(respond).toHaveBeenCalledWith(true, { session: expect.objectContaining(expected) });
        expect(projection.snapshot(query, options).row).toMatchObject(expected);
        nativeCalls!.expectIdle();
      }
    });
    onTestFinished(() => run);
    return run;
  },
);

it("keeps projection reads outside borrowed startup admission and admits completed recovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: {}, worker: {} },
        defaults: { sessionStore: { agentId: "main" } },
      },
    };
    const { query } = seedProjectionRow("recovering", {}, "worker");
    const { query: unaffected } = seedProjectionRow("unchanged");
    const path = agentDb.resolveOpenClawAgentSqlitePath({ agentId: query.agentId });
    agentDb.closeOpenClawAgentDatabaseByPath(path, query.agentId);
    const refusal = admission.createAgentDatabaseInspectionRefusal({
      agentId: query.agentId,
      paths: [path],
      pending: true,
      reason: "Startup preparation is still pending",
    });
    admission.recordAgentDatabaseAdmissions([refusal], { source: "startup" });
    using projection = await rows.createTestProjection({ cfg });
    expect(projection.snapshot(query).row).toBeNull();
    let beforeRecovery = 0;
    await admission.preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {
      sessionChanges.emit({ all: true, scope: "config" });
      expect(projection.capture(query)).toBeUndefined();
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row).toBeNull();
      expect(listOpenClawAgentDatabasesForTest().some((db) => db.path === path)).toBe(false);
      projection.snapshot(unaffected);
      beforeRecovery = projection.materializedCount;
    });
    await projection.ensureMaterialized();
    expect(projection.snapshot(query).row?.sessionId).toBe("recovering");
    expect(projection.snapshot(unaffected).row?.sessionId).toBe("unchanged");
    expect(projection.materializedCount - beforeRecovery).toBe(1);
  });
});
