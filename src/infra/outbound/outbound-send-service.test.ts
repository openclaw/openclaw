import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const mocks = vi.hoisted(() => ({
  getDefaultMediaLocalRoots: vi.fn(() => []),
  dispatchChannelMessageAction: vi.fn(),
  sendMessage: vi.fn(),
  sendPoll: vi.fn(),
  getAgentScopedMediaLocalRootsForSources: vi.fn(() => ["/tmp/agent-roots"]),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));

vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
}));

vi.mock("./message.js", () => ({
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
}));

vi.mock("../../media/local-roots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/local-roots.js")>();
  return {
    ...actual,
    getDefaultMediaLocalRoots: mocks.getDefaultMediaLocalRoots,
    getAgentScopedMediaLocalRootsForSources: mocks.getAgentScopedMediaLocalRootsForSources,
  };
});

vi.mock("../../config/sessions.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

type OutboundSendServiceModule = typeof import("./outbound-send-service.js");

let executePollAction: OutboundSendServiceModule["executePollAction"];
let executeSendAction: OutboundSendServiceModule["executeSendAction"];

describe("executeSendAction", () => {
  function pluginActionResult(messageId: string) {
    return {
      ok: true,
      value: { messageId },
      continuePrompt: "",
      output: "",
      sessionId: "s1",
      model: "gpt-5.4",
      usage: {},
    };
  }

  function expectMirrorWrite(
    expected: Partial<{
      agentId: string;
      sessionKey: string;
      text: string;
      idempotencyKey: string;
      mediaUrls: string[];
    }>,
  ) {
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining(expected),
    );
  }

  async function executePluginMirroredSend(params: {
    mirror?: Partial<{
      sessionKey: string;
      agentId?: string;
      idempotencyKey?: string;
    }>;
    mediaUrls?: string[];
  }) {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: { to: "channel:123", message: "hello" },
        dryRun: false,
        mirror: {
          sessionKey: "agent:main:discord:channel:123",
          ...params.mirror,
        },
      },
      to: "channel:123",
      message: "hello",
      mediaUrls: params.mediaUrls,
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    ({ executePollAction, executeSendAction } = await import("./outbound-send-service.js"));
    mocks.dispatchChannelMessageAction.mockClear();
    mocks.sendMessage.mockClear();
    mocks.sendPoll.mockClear();
    mocks.getDefaultMediaLocalRoots.mockClear();
    mocks.getAgentScopedMediaLocalRootsForSources.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
  });

  it("forwards ctx.agentId to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        agentId: "work",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        channel: "discord",
        to: "channel:123",
        content: "hello",
      }),
    );
  });

  it("uses plugin poll action when available", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        dryRun: false,
      },
      resolveCorePoll: () => ({
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
      }),
    });

    expect(result.handledBy).toBe("plugin");
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("does not invoke shared poll parsing before plugin poll dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));
    const resolveCorePoll = vi.fn(() => {
      throw new Error("shared poll fallback should not run");
    });

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 90,
          pollPublic: true,
        },
        dryRun: false,
      },
      resolveCorePoll,
    });

    expect(result.handledBy).toBe("plugin");
    expect(resolveCorePoll).not.toHaveBeenCalled();
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media local roots to plugin dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: { to: "channel:123", message: "hello" },
        agentId: "agent-1",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: [],
    });
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-roots"],
      }),
    );
  });

  it("passes concrete media sources when widening plugin dispatch roots", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {
          to: "channel:123",
          message: "hello",
          media: "/Users/peter/Pictures/photo.png",
        },
        agentId: "agent-1",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
      mediaUrl: "/Users/peter/Pictures/photo.png",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
  });

  it("passes mirror idempotency keys through plugin-handled sends", async () => {
    await executePluginMirroredSend({
      mirror: {
        idempotencyKey: "idem-plugin-send-1",
      },
    });

    expectMirrorWrite({
      sessionKey: "agent:main:discord:channel:123",
      text: "hello",
      idempotencyKey: "idem-plugin-send-1",
    });
  });

  it("falls back to message and media params for plugin-handled mirror writes", async () => {
    await executePluginMirroredSend({
      mirror: {
        agentId: "agent-9",
      },
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });

    expectMirrorWrite({
      agentId: "agent-9",
      sessionKey: "agent:main:discord:channel:123",
      text: "hello",
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
  });

  it("skips plugin dispatch during dry-run sends and forwards gateway + silent to sendMessage", async () => {
    mocks.sendMessage.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      via: "gateway",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: { to: "channel:123", message: "hello" },
        dryRun: true,
        silent: true,
        gateway: {
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:123",
        content: "hello",
        dryRun: true,
        silent: true,
        gateway: expect.objectContaining({
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
        }),
      }),
    );
  });

  it("forwards poll args to sendPoll on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendPoll.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: null,
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        accountId: "acc-1",
        dryRun: false,
      },
      resolveCorePoll: () => ({
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationSeconds: 300,
        threadId: "thread-1",
        isAnonymous: true,
      }),
    });

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acc-1",
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationSeconds: 300,
        threadId: "thread-1",
        isAnonymous: true,
      }),
    );
  });

  it("skips plugin dispatch during dry-run polls and forwards durationHours + silent", async () => {
    mocks.sendPoll.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: 6,
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        dryRun: true,
        silent: true,
        gateway: {
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      resolveCorePoll: () => ({
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationHours: 6,
      }),
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:123",
        question: "Lunch?",
        durationHours: 6,
        dryRun: true,
        silent: true,
        gateway: expect.objectContaining({
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
        }),
      }),
    );
  });
});
