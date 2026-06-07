// Tests Talk realtime chat-final adapter.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { deliverTalkRealtimeChatRunFinal } from "./talk-realtime-chat-final.js";
import { deliverTalkRealtimeRelayAgentRunFinal } from "./talk-realtime-relay.js";

vi.mock("./talk-realtime-relay.js", () => ({
  deliverTalkRealtimeRelayAgentRunFinal: vi.fn(),
}));

describe("talk realtime chat final adapter", () => {
  beforeEach(() => {
    vi.mocked(deliverTalkRealtimeRelayAgentRunFinal).mockReset();
  });

  it("delivers speakable chat final text to a registered Talk relay run", async () => {
    vi.mocked(deliverTalkRealtimeRelayAgentRunFinal).mockReturnValue(true);

    await expect(
      deliverTalkRealtimeChatRunFinal({
        sessionKey: "main",
        clientRunId: "client-run",
        sourceRunId: "source-run",
        state: "done",
        text: "Done.",
      }),
    ).resolves.toBe(true);

    expect(deliverTalkRealtimeRelayAgentRunFinal).toHaveBeenCalledTimes(1);
    expect(deliverTalkRealtimeRelayAgentRunFinal).toHaveBeenCalledWith({
      runId: "client-run",
      sessionKey: "main",
      result: { response: "Done." },
      source: "agent-final",
    });
  });

  it("tries the source run id when the client run id is not registered", async () => {
    vi.mocked(deliverTalkRealtimeRelayAgentRunFinal)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(
      deliverTalkRealtimeChatRunFinal({
        sessionKey: "main",
        clientRunId: "client-run",
        sourceRunId: "source-run",
        state: "done",
        text: "Finished.",
      }),
    ).resolves.toBe(true);

    expect(deliverTalkRealtimeRelayAgentRunFinal).toHaveBeenNthCalledWith(1, {
      runId: "client-run",
      sessionKey: "main",
      result: { response: "Finished." },
      source: "agent-final",
    });
    expect(deliverTalkRealtimeRelayAgentRunFinal).toHaveBeenNthCalledWith(2, {
      runId: "source-run",
      sessionKey: "main",
      result: { response: "Finished." },
      source: "agent-final",
    });
  });

  it("delivers error finals as structured error text", async () => {
    vi.mocked(deliverTalkRealtimeRelayAgentRunFinal).mockReturnValue(true);

    await deliverTalkRealtimeChatRunFinal({
      sessionKey: "main",
      clientRunId: "client-run",
      sourceRunId: "client-run",
      state: "error",
      error: new Error("model failed"),
    });

    expect(deliverTalkRealtimeRelayAgentRunFinal).toHaveBeenCalledWith({
      runId: "client-run",
      sessionKey: "main",
      result: { error: "Error: model failed" },
      source: "agent-final",
    });
  });
});
