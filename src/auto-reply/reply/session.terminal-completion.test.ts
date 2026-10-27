import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  initSessionState,
  readSessionStore as readSessionStoreFast,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);

describe("terminal completion session reuse", () => {
  it.each(["failed", "timeout", "killed"] as const)(
    "reuses a %s session without changing its transcript when a later channel source arrives",
    async (status) => {
      const storePath = path.join(tempDirs.make("openclaw-terminal-completion-"), "sessions.json");
      const sessionKey = "agent:main:slack:fixture:direct:requester";
      const sessionId = "completion-session";
      const sourceRunId = "announce:child:succeeded";
      const retained = {
        sessionId,
        lifecycleRevision: "completion-revision",
        status,
        abortedLastRun: true,
      };
      await writeSessionStoreFast(storePath, {
        [sessionKey]: { ...retained, updatedAt: Date.now() },
      });
      const scope = { agentId: "main", storePath, sessionId };
      await appendTranscriptMessage(
        { ...scope, sessionKey },
        {
          eventId: "completion-input",
          message: {
            role: "user",
            content: "The child task completed.",
            idempotencyKey: `${sourceRunId}:user`,
            provenance: {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: "agent_harness_completion",
              sourceSessionKey: "child",
            },
            __openclaw: { runId: sourceRunId },
          },
        },
      );
      const transcriptBefore = await loadTranscriptEvents(scope);
      const result = await initSessionState({
        cfg: { session: { store: storePath } },
        ctx: { Body: "Are you there?", SessionKey: sessionKey, Provider: "slack" },
      });
      const entry = readSessionStoreFast(storePath)[sessionKey];
      expect(result.isNewSession).toBe(false);
      expect(result.abortedLastRun).toBe(true);
      expect(entry).toMatchObject(retained);
      expect(await loadTranscriptEvents(scope)).toEqual(transcriptBefore);
    },
  );
});
