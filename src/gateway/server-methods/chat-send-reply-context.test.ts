// Covers webchat reply-target hydration into the channel-agnostic ReplyTo*
// envelope fields consumed by inbound-meta reply context blocks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChatSendReplyContext } from "./chat-send-reply-context.js";

const readSessionMessageByIdAsyncMock = vi.fn();
const resolveAssistantIdentityMock = vi.fn((..._args: unknown[]) => ({
  agentId: "main",
  name: "Molty",
  avatar: "M",
}));

vi.mock("../session-transcript-readers.js", () => ({
  readSessionMessageByIdAsync: (...args: unknown[]) => readSessionMessageByIdAsyncMock(...args),
}));
vi.mock("../assistant-identity.js", () => ({
  resolveAssistantIdentity: (...args: unknown[]) => resolveAssistantIdentityMock(...args),
}));

const cfg = {} as OpenClawConfig;

function baseParams(overrides: Partial<Parameters<typeof resolveChatSendReplyContext>[0]> = {}) {
  return {
    replyToId: "msg-1",
    cfg,
    agentId: "main",
    sessionKey: "agent:main:webchat",
    sessionEntry: { sessionFile: "session.jsonl", sessionId: "session-1" },
    storePath: "/tmp/sessions.json",
    ...overrides,
  };
}

describe("resolveChatSendReplyContext", () => {
  beforeEach(() => {
    readSessionMessageByIdAsyncMock.mockReset();
  });

  it("returns no fields without a reply id", async () => {
    expect(await resolveChatSendReplyContext(baseParams({ replyToId: undefined }))).toEqual({});
    expect(await resolveChatSendReplyContext(baseParams({ replyToId: "  " }))).toEqual({});
    expect(readSessionMessageByIdAsyncMock).not.toHaveBeenCalled();
  });

  it("keeps only the reply id when the target message is missing", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({ found: false });

    expect(await resolveChatSendReplyContext(baseParams())).toEqual({ ReplyToId: "msg-1" });
  });

  it("keeps only the reply id when no session exists yet", async () => {
    expect(await resolveChatSendReplyContext(baseParams({ sessionEntry: undefined }))).toEqual({
      ReplyToId: "msg-1",
    });
    expect(readSessionMessageByIdAsyncMock).not.toHaveBeenCalled();
  });

  it("tolerates read failures and reports them through warn", async () => {
    readSessionMessageByIdAsyncMock.mockRejectedValue(new Error("transcript unavailable"));
    const warn = vi.fn();

    expect(await resolveChatSendReplyContext(baseParams({ warn }))).toEqual({
      ReplyToId: "msg-1",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("hydrates only display-visible content, not raw transcript payloads", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "visible answer" },
          { type: "text", text: '<tool_call>{"name":"exec","arguments":{}}</tool_call>' },
        ],
        __openclaw: { id: "msg-1" },
      },
    });

    const fields = await resolveChatSendReplyContext(baseParams());

    expect(fields.ReplyToBody).toContain("visible answer");
    expect(fields.ReplyToBody).not.toContain("tool_call");
    expect(fields.ReplyToSender).toBe("Molty");
  });

  it("strips inbound envelope wrappers from user reply targets", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "user",
        content: "[Sat 2026-07-18 11:31 MDT] Which stage runs the integration tests?",
      },
    });

    const fields = await resolveChatSendReplyContext(baseParams({ userSenderLabel: "Ada" }));

    expect(fields.ReplyToBody).toBe("Which stage runs the integration tests?");
    expect(fields.ReplyToSender).toBe("Ada");
  });

  it("keeps only the reply id when the target is not display-visible", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
        __openclaw: { id: "msg-1" },
      },
    });

    expect(await resolveChatSendReplyContext(baseParams())).toEqual({ ReplyToId: "msg-1" });
  });
});
