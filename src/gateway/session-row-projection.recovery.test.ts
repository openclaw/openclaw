import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import * as indexes from "../config/sessions/session-transcript-reconcile.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
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
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

afterEach(() => vi.restoreAllMocks());

const messages = [
  { role: "user", content: "Recovered question" },
  { role: "assistant", content: "Recovered answer" },
];
it("serves cold previews without restoring history or mutating metadata", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
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
    {
      using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 86_400_000);
      await expect(
        runSessionColdStorageMaintenance({
          config: {
            ...cfg,
            session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } },
          },
        }),
      ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    }
    const database = agentDb.openOpenClawAgentDatabase(scope);
    const archive = readSessionColdTranscript(database.db, scope.sessionId);
    expect(archive).toBeDefined();
    const originalEntry = sessions.loadSessionEntry(scope);
    const context = reads.requestContext(cfg),
      client = reads.identifiedClient("viewer@example.com");
    const options = { includeLastMessage: true };
    const list = () => reads.listSessions({ context, client, request: options });
    using cleanup = new DisposableStack();
    cleanup.defer(() => getSessionRowProjection(context)?.dispose());
    const populated = backfill.observeSessionRowBackfill([scope.sessionKey]);
    await list();
    await withinTest(populated, signal);
    const initial = await list();
    expect(initial.sessions).toEqual([
      expect.objectContaining({ key: scope.sessionKey, sharingRole: "viewer" }),
    ]);
    expect(readSessionColdTranscript(database.db, scope.sessionId)).toEqual(archive);
    expect(initial.sessions[0]?.lastMessagePreview).toBe("Recovered answer");
    const projection = getSessionRowProjection(context)!;
    const sharingEntry = projection.capture(query)?.sharingEntry;
    const history = await readSessionMessagesPageWithStatsAsync(scope, {
      maxMessages: 100,
      offset: 0,
    });
    expect(history.messages).toEqual(messages.map((message) => expect.objectContaining(message)));
    expect(readSessionColdTranscript(database.db, scope.sessionId)).toEqual(archive);
    expect(projection.capture(query)?.sharingEntry).toEqual(sharingEntry);
    const expected = { key: scope.sessionKey, lastMessagePreview: "Recovered answer" };
    expect(sessions.loadSessionEntry(scope)).toEqual(originalEntry);
    const nativeCalls = observeMainThreadSql();
    const healed = await list();
    expect(healed.sessions).toEqual([
      expect.objectContaining({
        ...expected,
        sharingRole: "viewer",
      }),
    ]);
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
    nativeCalls.expectIdle();
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
