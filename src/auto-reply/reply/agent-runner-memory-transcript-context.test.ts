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
