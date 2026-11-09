// @vitest-environment node
import { expect, it, vi } from "vitest";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { historyMessage as message } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

vi.mock("./chat-history-page-preparation.ts", async () => {
  throw new Error("Tail module delivery failed");
});

vi.mock("./chat-history-inflight.runtime.ts", async () => {
  throw new Error("Active-run module delivery failed");
});

it.each(["continuity", "active-run"] as const)(
  "keeps the held transcript and exposes a failed %s module load",
  async (kind) => {
    const held = message("assistant", "Held", { id: "held", seq: 1 });
    const host = makeChatHost({
      currentSessionId: "session",
      chatMessages: [held],
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionId: "session",
          hasMore: false,
          ...(kind === "active-run"
            ? { inFlightRun: { runId: "active", text: "", events: [] } }
            : {}),
        },
      },
    });
    await expect(loadChatHistory(host)).resolves.toBeUndefined();
    expect(host.chatMessages).toEqual([held]);
    expect(host.chatMessages[0]).toBe(held);
    expect(getChatHistoryLoadState(host)).toMatchObject({
      phase: "failed",
      message: expect.stringContaining(
        kind === "active-run" ? "Active-run module delivery failed" : "Tail module delivery failed",
      ),
    });
    expect(host.chatLoading).toBe(false);
  },
);
