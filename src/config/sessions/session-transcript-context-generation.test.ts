import { expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadTranscriptEventsSync } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";

it.each(["transcript", "lifecycle"] as const)(
  "does not revive an awaiting context consumer after %s revocation and restoration",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:authority-aba",
        sessionId: "authority-aba",
        storePath: database.path,
        env: state.env,
      };
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope);
      manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
      const events = loadTranscriptEventsSync(scope);
      const before = readTranscriptContextVersionInTransaction(database, scope.sessionId);
      await expect(
        SessionManager.readSessionContextAsync(scope, async () => {
          if (kind === "lifecycle") {
            replaceSessionEntrySync(scope, {
              sessionId: scope.sessionId,
              updatedAt: 1,
              lifecycleRevision: "revoked",
            });
            replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          } else {
            replaceTranscriptEventsSync(scope, []);
            replaceTranscriptEventsSync(scope, events);
            // Emulate an external restore of the old snapshot. A revoked captured consumer stays revoked.
            database.db
              .prepare(
                "UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?",
              )
              .run(before.generation, scope.sessionId);
            database.db
              .prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?")
              .run(before.updatedAt, scope.sessionId);
          }
          return "must not disclose";
        }),
      ).rejects.toThrow("Session transcript changed during context read");
    });
  },
);
