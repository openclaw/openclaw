import { describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_RECORD_TEXT_MAX_BYTES } from "../../sessions/local-session-source-protocol.js";
import { handleLocalSessionChatSend } from "./chat-send-local-session.js";

const submitInput = vi.fn();

vi.mock("../local-sessions/bridge.js", () => ({
  getLocalSessionBridge: () => ({
    getStatus: () => ({ inputModes: ["followup"] }),
    submitInput,
  }),
}));

function send(rawMessage: string) {
  const respond = vi.fn();
  void handleLocalSessionChatSend({
    // SAFETY: the handler reads only rawMessage, attachments, and queueMode from the request.
    request: { rawMessage, normalizedAttachments: [], p: {} } as never,
    // SAFETY: the handler reads only the entry marker and routing ids from the prepared session.
    session: {
      entry: { localSource: {} },
      sessionKey: "agent:main:local:codex:d:owner:t",
      agentId: "main",
      storePath: "/tmp/agent.sqlite",
      clientRunId: "run-1",
    } as never,
    respond,
    client: null,
  });
  return respond;
}

describe("handleLocalSessionChatSend", () => {
  it("refuses a message the device frame decoder would reject, without touching the bridge", async () => {
    submitInput.mockReset();
    const respond = send("x".repeat(LOCAL_SESSION_RECORD_TEXT_MAX_BYTES + 1));
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("limited to 64 KiB"),
    });
    expect(submitInput).not.toHaveBeenCalled();
  });

  it("defaults to the source's advertised mode when the caller sets none", async () => {
    submitInput.mockReset().mockResolvedValue({ inputId: "in-1", state: "accepted" });
    const respond = send("hello");
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(submitInput.mock.calls[0]?.[0]).toMatchObject({
      inputId: "run-1",
      mode: "followup",
      text: "hello",
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "submitted" });
  });
});
