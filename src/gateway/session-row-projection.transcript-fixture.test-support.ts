import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";

/** The legacy roster and transcript payload used by resident-drain regressions. */
export function seedSessionRowProjectionTranscriptFixture() {
  const count = 2_048;
  const content = "Synthetic transcript payload. ".repeat(512);
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < count; index++) {
        const sessionId = `legacy-${index}`;
        const sessionKey = `agent:main:${sessionId}`;
        writeSessionEntry(
          database,
          sessionKey,
          {
            sessionId,
            updatedAt: index + 1,
            ...(index === count / 2
              ? {
                  status: "done" as const,
                  lastRunId: "fallback-run",
                  providerOverride: "unit-test",
                  modelOverride: "selected",
                  fallbackNotice: {
                    kind: "active" as const,
                    selectedModel: "unit-test/selected",
                    activeModel: "unit-test/fallback",
                  },
                }
              : {}),
          },
          { canonicalPreviousEntry: null, previousEntry: null },
        );
        appendTranscriptEventsInTransaction(database, { agentId: "main", sessionId, sessionKey }, [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: "user",
            parentId: null,
            message: { role: "user", content: `Explain legacy session ${index}` },
          },
          {
            type: "message",
            id: "assistant",
            parentId: "user",
            message: { role: "assistant", content },
          },
        ]);
      }
    },
    { agentId: "main" },
  );
  return count;
}
