import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

it("refreshes automation names across history reads after rename and deletion without a source session", async () => {
  await withOpenClawTestState({ label: "cron-attribution" }, async (state) => {
    const job: CronJob = {
      id: "daily-report",
      name: "Daily report",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Check the queue." },
      state: {},
    };
    const storePath = resolveCronJobsStorePath();
    const entry = { sessionId: "destination", updatedAt: 1 };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: entry.sessionId,
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: entry.sessionId }]);
    const sourceSessionKey = "agent:main:cron:daily-report:run:completed-run";
    const message = {
      role: "user",
      content: "The queue is clear.",
      provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey },
    };
    await appendTranscriptMessage(scope, { eventId: "forwarded-result", message, now: 2 });
    const pageParams = {
      entry,
      provider: "openai",
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 10,
      offset: undefined,
      messageId: undefined,
      maxHistoryBytes: 1_000_000,
      effectiveMaxChars: 100_000,
    };
    for (const name of ["Daily report", "Renamed report", undefined]) {
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: name ? [{ ...job, name, updatedAtMs: 3 }] : [],
      });
      const expected = {
        role: "assistant",
        content: "The queue is clear.",
        senderSession: {
          sessionKey: sourceSessionKey,
          agentId: "main",
          label: name ?? "Automation",
        },
      };
      expect((await readChatHistoryPage(pageParams)).messages).toMatchObject([expected]);
      expect(
        (await readChatHistoryPage({ ...pageParams, messageId: "forwarded-result" })).messages,
      ).toMatchObject([expected]);
      for (const limit of [10, undefined]) {
        const snapshot = await readSessionHistorySnapshotAsync({
          target: { ...scope, sessionEntry: entry },
          limit,
          maxChars: 100_000,
        });
        expect(snapshot.history.messages).toMatchObject([expected]);
      }
      expect(
        projectSessionMessagePayload({ message, sessionKey: scope.sessionKey }).payload?.message,
      ).toMatchObject(expected);
    }
  });
});
