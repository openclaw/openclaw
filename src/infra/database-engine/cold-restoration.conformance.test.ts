import { isMainThread } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../../config/sessions/session-cold-storage.js";
import { loadSessionTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

installDatabaseProcessRole("gateway");

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    engine + " cold transcript restoration",
    () => {
      useMixedAgentPair("sqlite", engine);

      it("restores and appends without a host compatibility connection, preserving the old rows and generation", async () => {
        expect(isMainThread).toBe(true);
        const fixture = withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const scope = {
            agentId: "main",
            sessionKey: "agent:main:cold-custody",
            sessionId: "cold-custody-window",
            storePath: database.path,
          };
          const options = { agentId: scope.agentId, path: database.path };
          replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          replaceTranscriptEventsSync(scope, [
            { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
            {
              type: "message",
              id: "original",
              parentId: null,
              timestamp: "2020-01-01T00:00:00.000Z",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Original cold reply" }],
              },
            },
          ]);
          runOpenClawAgentWriteTransaction(({ db }) => {
            db.prepare(
              "UPDATE session_nodes SET updated_at = 1, last_activity_at = 1, last_interaction_at = 1 WHERE session_key = ?",
            ).run(scope.sessionKey);
            db.prepare(
              "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1, transcript_observed_at = 1 WHERE session_id = ?",
            ).run(scope.sessionId);
          }, options);
          const snapshot = () => ({
            rows: openOpenClawAgentDatabase(options)
              .db.prepare(
                "SELECT seq, created_at, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq",
              )
              .all(scope.sessionId),
            generation: openOpenClawAgentDatabase(options)
              .db.prepare(
                "SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?",
              )
              .get(scope.sessionId),
          });
          return { scope, options, before: snapshot(), snapshot };
        });
        await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
        await expect(
          runSessionColdStorageMaintenance({
            config: {
              agents: { entries: { main: {} } },
              session: {
                store: fixture.options.path,
                maintenance: { coldStorage: { enabled: true, afterDays: 1 } },
              },
            },
          }),
        ).resolves.toMatchObject({ archivedTranscripts: 1 });
        await closeOpenClawAgentDatabaseByPathAsync(fixture.options.path);
        expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();

        let restorationPublications = 0;
        const unsubscribe = sessionChanges.subscribe((change) => {
          if ("all" in change) {
            return;
          }
          if (change.sessionKey === fixture.scope.sessionKey && change.scope === "transcript") {
            restorationPublications++;
          }
        });
        try {
          await restoreSessionColdTranscript(fixture.scope);
        } finally {
          unsubscribe();
        }
        expect(restorationPublications).toBe(1);
        await expect(
          appendTranscriptMessage(fixture.scope, {
            eventId: "resumed",
            message: {
              role: "user",
              content: [{ type: "text", text: "Resume the cold conversation" }],
            },
          }),
        ).resolves.toMatchObject({ appended: true, messageId: "resumed" });
        await expect(
          appendTranscriptMessage(fixture.scope, {
            eventId: "later",
            message: { role: "assistant", content: [{ type: "text", text: "Later reply" }] },
          }),
        ).resolves.toMatchObject({ appended: true, messageId: "later" });
        const events = await loadSessionTranscriptEvents(fixture.scope);
        expect(events).toMatchObject([
          { id: fixture.scope.sessionId },
          { id: "original" },
          { id: "resumed" },
          { id: "later" },
        ]);
        expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
        withEngineStoreAdmission(() => {
          const after = fixture.snapshot();
          expect(after.rows.slice(0, fixture.before.rows.length)).toEqual(fixture.before.rows);
          expect(after.generation).toEqual(fixture.before.generation);
        });
      });
    },
  );
}
