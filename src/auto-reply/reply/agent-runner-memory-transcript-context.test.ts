import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { useTranscriptFixture } from "../../gateway/session-transcript-fixtures.test-support.js";
import * as transcriptReaders from "../../gateway/session-transcript-readers.js";
import { estimateContextTokensFromSessionTranscript } from "./agent-runner-memory-transcript-context.js";

const fixture = useTranscriptFixture("bounded-preflight-accounting-");

it("does not repeat accounting over the full history when its bounded tail has no usage", async () => {
  const target = fixture.scopeFor("session");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 10 });
  await fixture.writeTranscript(
    target.sessionId,
    Array.from({ length: 600 }, (_, index) => ({
      type: "message",
      id: `question-${index}`,
      parentId: index === 0 ? null : `question-${index - 1}`,
      message: { role: "user", content: `Question ${index}`, timestamp: index },
    })),
  );
  const accounting = vi.spyOn(transcriptReaders, "readSessionTranscriptAccountingAsync");
  try {
    const estimate = await estimateContextTokensFromSessionTranscript({
      ...target,
      contextWindowTokens: 100_000,
    });
    expect(estimate?.contextTokens).toBeGreaterThan(600);
    expect(estimate?.contextTokens).toBeLessThan(10_000);
    // Missing usage falls through to bounded model context, never a second history-sized read.
    expect(accounting).toHaveBeenCalledTimes(1);
  } finally {
    accounting.mockRestore();
  }
});

it("keeps the agent context size when a realtime voice billing row follows it", async () => {
  const target = fixture.scopeFor("voice");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 10 });
  await fixture.writeTranscript(target.sessionId, [
    {
      type: "message",
      id: "question",
      parentId: null,
      message: { role: "user", content: "Summarize the project.", timestamp: 1 },
    },
    {
      type: "message",
      id: "agent",
      parentId: "question",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the summary." }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-luna",
        usage: { input: 100_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 100_500 },
        stopReason: "stop",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "realtime-usage",
      parentId: "agent",
      message: {
        role: "assistant",
        content: [],
        api: "realtime",
        provider: "openai",
        model: "gpt-realtime-2.1",
        usage: { input: 900, output: 400, cacheRead: 600, cacheWrite: 0, totalTokens: 1_900 },
        stopReason: "stop",
        timestamp: 3,
      },
    },
  ]);
  const estimate = await estimateContextTokensFromSessionTranscript({
    ...target,
    contextWindowTokens: 200_000,
  });
  expect(estimate?.contextTokens).toBeGreaterThanOrEqual(100_000);
});
