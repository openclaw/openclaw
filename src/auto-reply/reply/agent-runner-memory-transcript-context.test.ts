import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as transcriptReaders from "../../gateway/session-transcript-readers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { estimatePromptTokensFromSessionTranscript } from "./agent-runner-memory-transcript-context.js";

it("does not repeat accounting over the full history when its bounded tail has no usage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:session",
      storePath: state.sessionsDir() + "/sessions.json",
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 10 });
    await replaceTranscriptEvents(target, [
      { type: "session", id: target.sessionId, version: 3, cwd: "/synthetic" },
      ...Array.from({ length: 600 }, (_, index) => ({
        type: "message",
        id: `question-${index}`,
        parentId: index === 0 ? null : `question-${index - 1}`,
        message: { role: "user", content: `Question ${index}`, timestamp: index },
      })),
    ]);
    const accounting = vi.spyOn(transcriptReaders, "readSessionTranscriptAccountingAsync");
    try {
      const estimate = await estimatePromptTokensFromSessionTranscript({
        ...target,
        contextWindowTokens: 100_000,
      });
      expect(estimate?.promptTokens).toBeGreaterThan(600);
      expect(estimate?.promptTokens).toBeLessThan(10_000);
      // Missing usage falls through to bounded model context, never a second history-sized read.
      expect(accounting).toHaveBeenCalledTimes(1);
    } finally {
      accounting.mockRestore();
    }
  });
});
