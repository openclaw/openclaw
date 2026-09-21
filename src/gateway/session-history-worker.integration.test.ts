import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { readActiveTranscriptEntryAnchor } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";

it.each([
  { agentId: "Other", sessionKey: "agent:other:fenced-history" },
  { agentId: "other", sessionKey: "Agent:Other:Fenced-History" },
])(
  "validates worker admission for normalized logical inputs in a shared store: %j",
  async (input) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env: state.env,
        path: state.statePath("shared-history.sqlite"),
      });
      const target = {
        agentId: "other",
        sessionKey: "agent:other:fenced-history",
        sessionId: "requested-fenced-history",
        storePath: database.path,
      };
      const entry = { sessionId: target.sessionId, updatedAt: 1 };
      await replaceSessionEntry(target, entry);
      await replaceTranscriptEvents(target, [
        { type: "session", version: 3, id: target.sessionId },
        {
          type: "message",
          id: "before",
          parentId: null,
          message: { role: "user", content: "Visible requested history" },
        },
        {
          type: "message",
          id: "admitted",
          parentId: "before",
          message: { role: "user", content: "Current turn" },
        },
        {
          type: "message",
          id: "later",
          parentId: "admitted",
          message: { role: "assistant", content: "After the admitted boundary" },
        },
      ]);
      await waitForSessionTranscriptProjection(target);
      const anchor = readActiveTranscriptEntryAnchor({ ...target, entryId: "admitted" });
      if (!anchor) {
        throw new Error("expected current-turn transcript anchor");
      }
      expect(anchor).toMatchObject({
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: database.path,
      });
      expect(database.agentId).toBe("main");
      const admission = { ...anchor, logicalTurnId: "worker-fence", role: "user" as const };
      const readRpc = () =>
        readChatHistoryPage({
          entry,
          provider: undefined,
          sessionId: target.sessionId,
          storePath: target.storePath,
          sessionAgentId: input.agentId,
          canonicalKey: input.sessionKey,
          max: 10,
          maxHistoryBytes: 100_000,
          effectiveMaxChars: 8000,
          offset: undefined,
          messageId: undefined,
        });
      const readHttp = () =>
        readSessionHistorySnapshotAsync({
          target: { ...target, ...input, sessionEntry: entry },
          limit: 10,
        });
      const page = await runWithSessionTranscriptReadFence(admission, readRpc);
      expect(page.messages.map(readChatHistoryMessageId)).toEqual(["before", "admitted", "later"]);
      const http = await runWithSessionTranscriptReadFence(admission, readHttp);
      expect(http.history.messages.map(readChatHistoryMessageId)).toEqual([
        "before",
        "admitted",
        "later",
      ]);
      expect(http.transcriptPath).toBe(input.sessionKey);
      // Display rows remain visible, but normalization must not lose admission validation.
      const invalidAdmission = { ...admission, storePath: `${database.path}.other` };
      await expect(runWithSessionTranscriptReadFence(invalidAdmission, readRpc)).rejects.toThrow(
        "different transcript store",
      );
      await expect(runWithSessionTranscriptReadFence(invalidAdmission, readHttp)).rejects.toThrow(
        "different transcript store",
      );
      for (const sessionKey of [input.sessionKey, "fenced-history"]) {
        const readPreview = () =>
          readSessionPreviewItemsFromTranscriptAsync({ ...target, ...input, sessionKey }, 10, 160);
        expect(await runWithSessionTranscriptReadFence(admission, readPreview)).toEqual([
          { role: "user", text: "Visible requested history" },
          { role: "user", text: "Current turn" },
          { role: "assistant", text: "After the admitted boundary" },
        ]);
        await expect(
          runWithSessionTranscriptReadFence(invalidAdmission, readPreview),
        ).rejects.toThrow("different transcript store");
      }
    });
  },
);

it("reads a sparse page in the transcript worker and shares equivalent queued requests", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "worker-sparse-history",
      sessionKey: "agent:main:worker-sparse-history",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
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
      const pages = await Promise.all(Array.from({ length: 4 }, () => readChatHistoryPage(params)));
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
});

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
    const readDelta = async (cursor?: string) => {
      const scope = { ...target, sessionEntry: entry };
      const limits = { cursor, maxBytes: 1_000_000, maxEvents: 200 };
      const golden = readTranscriptDisplayDelta(scope, limits);
      const delta = await readSessionHistoryPageInWorker({
        kind: "delta",
        params: { target: scope, limits },
      });
      expect(JSON.stringify(delta)).toBe(JSON.stringify(golden));
      return delta.kind === "page" ? delta.cursor : undefined;
    };
    const beforeBranch = await readDelta();
    expect((await read()).history.messages.map(readChatHistoryMessageId)).toEqual(["A"]);
    await appendTranscriptEvent(target, {
      type: "leaf",
      id: "select-B",
      parentId: "A",
      targetId: "B",
      appendParentId: "B",
    });
    await waitForSessionTranscriptProjection(target);
    const beforeReset = await readDelta(beforeBranch);
    expect((await read()).history.messages.map(readChatHistoryMessageId)).toEqual(["B"]);
    await appendTranscriptEvent(target, {
      type: "reset",
      id: "reset-B",
      parentId: "B",
      reason: "new",
      timestamp: "2026-09-13T00:00:00.000Z",
    });
    await waitForSessionTranscriptProjection(target);
    await readDelta(beforeReset);
    const reset = await read();
    expect(reset.history.messages.map(readChatHistoryMessageId)).toEqual(["reset-B"]);
    expect(reset.rawTranscriptSeq).toBe(1);
  });
});
