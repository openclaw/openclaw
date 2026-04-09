import { beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";

const { listBySessionMock, getChannelPluginMock, normalizeChannelIdMock } = vi.hoisted(() => ({
  listBySessionMock: vi.fn(),
  getChannelPluginMock: vi.fn((channel: string) =>
    channel === "thread-chat" || channel === "room-chat"
      ? {
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        }
      : null,
  ),
  normalizeChannelIdMock: vi.fn((channel: string) => channel),
}));

vi.mock("../../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: listBySessionMock,
  }),
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  normalizeChannelId: normalizeChannelIdMock,
}));

let handleSubagentsAgentsAction: typeof import("./action-agents.js").handleSubagentsAgentsAction;

describe("handleSubagentsAgentsAction", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ handleSubagentsAgentsAction } = await import("./action-agents.js"));
    listBySessionMock.mockReset();
    getChannelPluginMock.mockClear();
    normalizeChannelIdMock.mockClear();
  });

  it("dedupes stale bound rows for the same child session", () => {
    const childSessionKey = "agent:main:subagent:worker";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            {
              bindingId: "binding-1",
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: THREAD_CHANNEL,
                accountId: "default",
                conversationId: "thread-1",
              },
              status: "active",
              boundAt: Date.now() - 20_000,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: THREAD_CHANNEL,
          Surface: THREAD_CHANNEL,
        },
        command: {
          channel: THREAD_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-current",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "current worker label",
          cleanup: "keep",
          createdAt: Date.now() - 10_000,
          startedAt: Date.now() - 10_000,
        },
        {
          runId: "run-stale",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale worker label",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
          endedAt: Date.now() - 15_000,
          outcome: { status: "ok" },
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("current worker label");
    expect(result.reply?.text).not.toContain("stale worker label");
  });

  it("keeps /agents numbering aligned with target resolution when hidden recent rows exist", () => {
    const hiddenSessionKey = "agent:main:subagent:hidden-recent";
    const visibleSessionKey = "agent:main:subagent:visible-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === visibleSessionKey
        ? [
            {
              bindingId: "binding-visible",
              targetSessionKey: visibleSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: THREAD_CHANNEL,
                accountId: "default",
                conversationId: "thread-visible",
              },
              status: "active",
              boundAt: Date.now() - 20_000,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: THREAD_CHANNEL,
          Surface: THREAD_CHANNEL,
        },
        command: {
          channel: THREAD_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-hidden-recent",
          childSessionKey: hiddenSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "hidden recent worker",
          cleanup: "keep",
          createdAt: Date.now() - 10_000,
          startedAt: Date.now() - 10_000,
          endedAt: Date.now() - 5_000,
          outcome: { status: "ok" },
        },
        {
          runId: "run-visible-bound",
          childSessionKey: visibleSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "visible bound worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
          endedAt: Date.now() - 15_000,
          outcome: { status: "ok" },
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("2. visible bound worker");
    expect(result.reply?.text).not.toContain("1. visible bound worker");
    expect(result.reply?.text).not.toContain("hidden recent worker");
  });

  it("shows room-channel runs as unbound when the plugin supports conversation bindings", () => {
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: ROOM_CHANNEL,
          Surface: ROOM_CHANNEL,
        },
        command: {
          channel: ROOM_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-room-worker",
          childSessionKey: "agent:main:subagent:room-worker",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "room worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("room worker (unbound)");
    expect(result.reply?.text).not.toContain("bindings unavailable");
  });

  it("formats bindings generically", () => {
    const childSessionKey = "agent:main:subagent:room-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            {
              bindingId: "binding-room",
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: ROOM_CHANNEL,
                accountId: "default",
                conversationId: "room-thread-1",
              },
              status: "active",
              boundAt: Date.now() - 20_000,
            },
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: ROOM_CHANNEL,
          Surface: ROOM_CHANNEL,
        },
        command: {
          channel: ROOM_CHANNEL,
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-room-bound",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "room bound worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("room bound worker (binding:room-thread-1)");
  });

  it("shows bindings unavailable for channels without conversation binding support", () => {
    getChannelPluginMock.mockReturnValueOnce(null);
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction({
      params: {
        ctx: {
          Provider: "irc",
          Surface: "irc",
        },
        command: {
          channel: "irc",
        },
      },
      requesterKey: "agent:main:main",
      runs: [
        {
          runId: "run-irc-worker",
          childSessionKey: "agent:main:subagent:irc-worker",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "irc worker",
          cleanup: "keep",
          createdAt: Date.now() - 20_000,
          startedAt: Date.now() - 20_000,
        },
      ],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain("irc worker (bindings unavailable)");
  });
});
