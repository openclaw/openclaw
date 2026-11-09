import { describe, expect, it, onTestFinished, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  historyRpc,
  historyPayload,
  seedHistorySession,
  seedHistoryTranscript,
  withHistoryState,
} from "./server-methods/chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import {
  transcriptMessage as event,
  useTranscriptFixture,
} from "./session-transcript-fixtures.test-support.js";
import * as readers from "./session-transcript-readers.js";
import {
  readSessionMessagesPageWithStatsAsync as readPage,
  readSessionTranscriptSummaryAsync as summary,
} from "./session-transcript-readers.js";

const call = (id: string, name: string, runId = "run") => ({
  role: "assistant",
  runId,
  content: [{ type: "toolCall", id, name: "skills_read", arguments: { name } }],
});
const result = (id: string, runId = "run") => ({
  role: "toolResult",
  runId,
  toolCallId: id,
  toolName: "skills_read",
  isError: false,
  content: [{ type: "text", text: "Instructions" }],
});

describe("session skill-load reconstruction", () => {
  const { writeTranscript } = useTranscriptFixture("transcript-skills-");
  it("reconstructs native and nested loads outside the display page, excludes inactive branches, and isolates sessions", async () => {
    const messages = [
      event("call", null, call("native", "review")),
      event("result", "call", result("native")),
      event("stale-call", "result", call("stale", "inactive-branch")),
      event("stale-result", "stale-call", result("stale")),
    ];
    let parent = "result";
    for (let i = 0; i < 90; i++) {
      const id = "filler-" + i;
      messages.push(event(id, parent, { role: "user", content: "Conversation content " + i }));
      parent = id;
    }
    messages.push(
      event(
        "nested",
        parent,
        createNestedToolActivity({
          runId: "nested-run",
          scopeId: "scope",
          afterEntryId: null,
          startOrder: 0,
          toolCallId: "nested-load",
          toolName: "skills_read",
          input: { name: "release" },
          result: { content: [{ type: "text", text: "Instructions" }] },
          isError: false,
          startedAt: 1,
          timestamp: 2,
        }),
      ),
      event("answer", "nested", { role: "assistant", content: "Done" }),
    );
    const scope = await writeTranscript("skills", messages);
    const page = await readPage(scope, { offset: 0, maxMessages: 1, maxBytes: 4096 });
    expect(page.messages).toHaveLength(1);
    expect(JSON.stringify(page.messages)).not.toContain("skills_read");
    expect(page.totalMessages).toBeGreaterThan(80);
    expect(await summary(scope, { kind: "skills-used" })).toEqual({
      kind: "skills-used",
      loads: [
        { id: '["run","native"]', name: "review" },
        { id: '["nested-run","nested-load"]', name: "release" },
      ],
    });
    const other = await writeTranscript("other", [
      event("other", null, { role: "user", content: "Separate conversation" }),
    ]);
    expect(await summary(other, { kind: "skills-used" })).toEqual({
      kind: "skills-used",
      loads: [],
    });
  });

  it("reconstructs only the current reset window", async () => {
    const scope = await writeTranscript("reset-skills", [
      event("old-call", null, call("old", "before-reset")),
      event("old-result", "old-call", result("old")),
      event("question", "old-result", { role: "user", content: "Start again" }),
      {
        type: "reset",
        id: "reset",
        parentId: "question",
        firstKeptEntryId: "question",
        timestamp: "2026-11-09T00:00:00.000Z",
      },
      event("new-call", "reset", call("new", "after-reset")),
      event("new-result", "new-call", result("new")),
    ]);
    expect(await summary(scope, { kind: "skills-used" })).toEqual({
      kind: "skills-used",
      loads: [{ id: '["run","new"]', name: "after-reset" }],
    });
  });
});

it("returns complete skill receipts through history RPC without recomputing them for older pages", () =>
  withHistoryState(async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = await seedHistorySession("skills-rpc");
    await seedHistoryTranscript(scope, [
      ["call", call("native", "review")],
      ["result", result("native")],
      ["tail", { role: "assistant", content: "Newest page" }],
    ]);
    const context = await createHistoryReadContext();
    const request = historyRpc(context, scope.sessionKey);
    const read = vi.spyOn(readers, "readSessionTranscriptSummaryAsync");
    onTestFinished(() => read.mockRestore());
    const tail = historyPayload(await request("chat.history", { limit: 1 }));
    expect(tail.skillsUsed).toEqual([{ id: '["run","native"]', name: "review" }]);
    expect(tail.messages).toHaveLength(1);
    const older = historyPayload(await request("chat.history", { offset: 1, limit: 1 }));
    expect(older.skillsUsed).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    const quiet = historyPayload(await request("chat.history", { cursor: tail.deltaCursor }));
    expect(quiet.kind).toBe("delta");
    expect(quiet.messages).toEqual([]);
    expect(quiet.skillsUsed).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: call("incremental", "release") }, { message: result("incremental") }],
    });
    const incremental = historyPayload(
      await request("chat.history", { cursor: quiet.deltaCursor }),
    );
    expect(incremental.kind).toBe("delta");
    expect(incremental.messages).not.toEqual([]);
    expect(incremental.skillsUsed).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  }));
