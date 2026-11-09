import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";

const mocks = vi.hoisted(() => ({
  readSessionMessagesAroundIdWithStatsAsync: vi.fn(),
}));

vi.mock("./session-transcript-readers.js", () => ({
  readRecentSessionMessagesWithStatsAsync: vi.fn(),
  readSessionMessagesAroundIdWithStatsAsync: mocks.readSessionMessagesAroundIdWithStatsAsync,
}));

import { createResetBoundaryTranscriptSource } from "./session-end-transcript-reader.js";

describe("reset-boundary ended transcript reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("keeps the boundary outside the full public message maximum", async () => {
    const boundaryId = "ended-boundary";
    const messageCount = 10_000;
    const messages = Array.from({ length: messageCount }, (_, index) => ({
      content: `message ${index}`,
      __openclaw: { id: `prior-${index}` },
    }));
    mocks.readSessionMessagesAroundIdWithStatsAsync.mockResolvedValue({
      found: true,
      messages,
      totalMessages: messageCount,
    });
    const scope = { agentId: "main", sessionId: "ended" } as SessionTranscriptReadScope;
    const source = createResetBoundaryTranscriptSource(scope, boundaryId);
    if (!source.available) {
      throw new Error("expected available ended transcript source");
    }

    const result = await source.readTail({ maxMessages: messageCount, maxBytes: 8 * 1024 * 1024 });

    expect(mocks.readSessionMessagesAroundIdWithStatsAsync).toHaveBeenCalledWith(scope, {
      closedResetInterval: true,
      messageId: boundaryId,
      maxMessages: messageCount,
      maxBytes: 8 * 1024 * 1024,
      direction: "older",
    });
    expect(result.messages).toHaveLength(messageCount);
    expect(result.messages).toEqual(messages);
    expect(result).toMatchObject({ totalMessages: messageCount, truncated: false });
  });
});
