// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";

describe("chat history state contention", () => {
  it("restores a quiet state contention wait without a provider retry or a new run", async () => {
    const history = activeHistory("run-1");
    history.inFlightRun = {
      runId: "run-1",
      text: "",
      events: [
        {
          runId: "run-1",
          seq: 2,
          stream: "run_status",
          ts: 1,
          data: { phase: "waiting_for_state" },
        },
      ],
    };
    const state = createState(history);
    state.chatMessage = "Unsent draft";
    if (!state.client) {
      throw new Error("Expected the history fixture client");
    }
    const request = vi.spyOn(state.client, "request");
    await loadChatHistory(state);
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      seq: 2,
      phase: "waiting_for_state",
    });
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatRunError).toBeFalsy();
    expect(state.chatMessage).toBe("Unsent draft");
    expect(request.mock.calls.some(([method]) => method === "chat.history")).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
});
