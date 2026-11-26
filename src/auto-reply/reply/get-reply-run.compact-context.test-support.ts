import { beforeEach, expect, it, vi } from "vitest";
import type { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import * as compactMeta from "./inbound-meta.compact.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

/**
 * Registers inside the media-only suite, which mocks inbound-meta.js and the reply runner.
 * The compact projection defaults to empty for every case; this module owns that default.
 */
export function registerCompactInboundContextCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  beforeEach(() => {
    vi.spyOn(compactMeta, "buildCompactInboundUserContextPrefix").mockReset().mockReturnValue({
      text: "",
      removedSessionMessages: 0,
      deduplicatedMessages: 0,
    });
  });

  it("preserves compact inbound context through reply admission", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValue("default context");
    vi.mocked(compactMeta.buildCompactInboundUserContextPrefix).mockReturnValue({
      text: "compact context",
      removedSessionMessages: 2,
      deduplicatedMessages: 1,
    });

    await runPrepared();

    expect(requireRunReplyAgentCall().followupRun.currentInboundContext).toMatchObject({
      text: "default context\n\n[Thread history - for context]\nEarlier message in this thread\n\n[Current message - respond to this]",
      compactText:
        "compact context\n\n[Thread history - for context]\nEarlier message in this thread\n\n[Current message - respond to this]",
      serializationStats: {
        removedSessionMessages: 2,
        deduplicatedMessages: 1,
      },
    });
  });
}
