import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { useTranscriptFixture } from "../../gateway/session-transcript-fixtures.test-support.js";
import * as transcriptReaders from "../../gateway/session-transcript-readers.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import {
  estimatePromptTokensFromSessionTranscript,
  readSessionLogSnapshot,
} from "./agent-runner-memory-transcript-context.js";

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
  using admission = vi.spyOn(writeAdmission, "runOpenClawAgentWriteAdmission");
  try {
    const snapshot = await readSessionLogSnapshot({
      ...target,
      includeByteSize: false,
      includeUsage: true,
    });
    expect(admission).not.toHaveBeenCalled();
    const estimate = await estimatePromptTokensFromSessionTranscript(
      { ...target, contextWindowTokens: 100_000 },
      snapshot,
    );
    expect(estimate?.promptTokens).toBeGreaterThan(600);
    expect(estimate?.promptTokens).toBeLessThan(10_000);
    // Missing usage falls through to bounded model context, never a second history-sized read.
    expect(accounting).toHaveBeenCalledTimes(1);
    expect(estimate).toMatchObject({
      promptTokenSource: "prompt_projection",
      promptIncludesOutput: true,
    });
  } finally {
    accounting.mockRestore();
  }
});

it("keeps provider prompt and output counters separate in the baseline contract", async () => {
  const estimate = await estimatePromptTokensFromSessionTranscript(
    { ...fixture.scopeFor("provider-usage"), contextWindowTokens: 100_000 },
    { usage: { promptTokens: 400.2, outputTokens: 25.2, trailingMessages: [] } },
  );
  expect(estimate).toEqual({
    promptTokens: 401,
    promptTokenSource: "provider_usage",
    outputTokens: 26,
  });
});
