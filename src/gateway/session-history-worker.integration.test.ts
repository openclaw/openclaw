import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

it.each(["canonical", "custom", "exact"] as const)(
  "reads a sparse page in the transcript worker and shares equivalent queued requests ($0 store)",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "worker-sparse-history",
        sessionKey: "agent:main:worker-sparse-history",
        storePath:
          store === "canonical"
            ? path.join(state.sessionsDir(), "sessions.json")
            : state.statePath(store === "custom" ? "history.json" : "history.sqlite"),
      };
      const entry = { sessionId: target.sessionId, updatedAt: 1 };
      await replaceSessionEntry(target, entry);
      const ids = Array.from({ length: 252 }, (_, index) => `row-${index}`);
      await replaceTranscriptEvents(target, [
        { type: "session", version: 3, id: target.sessionId },
        ...ids.map((id, index) => ({
          type: "message",
          id,
          parentId: ids[index - 1] ?? null,
          message:
            index === 0
              ? { role: "user", content: "Question before silent activity" }
              : {
                  role: "assistant",
                  content: index === ids.length - 1 ? "Visible final answer" : "NO_REPLY",
                },
        })),
      ]);
      await waitForSessionTranscriptProjection(target);
      const params = {
        entry,
        provider: undefined,
        sessionId: target.sessionId,
        storePath: target.storePath,
        sessionAgentId: target.agentId,
        canonicalKey: target.sessionKey,
        max: 2,
        maxHistoryBytes: 100_000,
        effectiveMaxChars: 8000,
        offset: undefined,
        messageId: undefined,
      };
      const diagnostics = channel("openclaw.worker.task");
      const tasks: unknown[] = [];
      const record = (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "worker" in value &&
          typeof value.worker === "string" &&
          value.worker.startsWith("session-transcript.worker")
        ) {
          tasks.push(value);
        }
      };
      diagnostics.subscribe(record);
      try {
        const pages = await Promise.all(
          Array.from({ length: 4 }, () => readChatHistoryPage(params)),
        );
        for (const page of pages) {
          expect(page.messages.map(readChatHistoryMessageId)).toEqual([ids[0], ids.at(-1)]);
          expect(page.pagination).toMatchObject({ totalMessages: 252, rawPageMessages: 252 });
        }
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks.length).toBeLessThan(pages.length);
      } finally {
        diagnostics.unsubscribe(record);
      }

      const http = await readSessionHistorySnapshotAsync({
        target: { ...target, sessionEntry: entry },
        limit: 2,
      });
      expect(http.history.items).toBe(http.history.messages);
      expect(http.history.messages.map(readChatHistoryMessageId)).toEqual([ids[0], ids.at(-1)]);
      expect(http.history.hasMore).toBe(false);
      expect(http.rawTranscriptSeq).toBe(252);

      const anchored = await readChatHistoryPage({ ...params, messageId: ids[0] });
      expect(anchored.messages.map(readChatHistoryMessageId)).toEqual([ids[0]]);
    });
  },
);

it("reads a new branch and reset interval after earlier worker pages settle", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "worker-history-branch",
      sessionKey: "agent:main:worker-history-branch",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      { type: "message", id: "A", parentId: null, message: { role: "user", content: "Branch A" } },
      { type: "message", id: "B", parentId: null, message: { role: "user", content: "Branch B" } },
      { type: "leaf", id: "select-A", parentId: "B", targetId: "A", appendParentId: "A" },
    ]);
    await waitForSessionTranscriptProjection(target);
    const read = () =>
      readSessionHistorySnapshotAsync({ target: { ...target, sessionEntry: entry }, limit: 10 });
    expect((await read()).history.messages.map(readChatHistoryMessageId)).toEqual(["A"]);
    await appendTranscriptEvent(target, {
      type: "leaf",
      id: "select-B",
      parentId: "A",
      targetId: "B",
      appendParentId: "B",
    });
    await waitForSessionTranscriptProjection(target);
    expect((await read()).history.messages.map(readChatHistoryMessageId)).toEqual(["B"]);
    await appendTranscriptEvent(target, {
      type: "reset",
      id: "reset-B",
      parentId: "B",
      reason: "new",
      timestamp: "2026-09-13T00:00:00.000Z",
    });
    await waitForSessionTranscriptProjection(target);
    const reset = await read();
    expect(reset.history.messages.map(readChatHistoryMessageId)).toEqual(["reset-B"]);
    expect(reset.rawTranscriptSeq).toBe(1);
  });
});
