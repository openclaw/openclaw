// `/subagents spawn --thread` binds a user-started subagent to a new child thread or topic,
// never to the conversation the user is in, and refuses where no child thread can exist.
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "../../../agents/subagents/spawn/subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "../../../agents/test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  bind: vi.fn(),
}));

type BindInput = {
  targetSessionKey: string;
  targetKind: string;
  placement: "current" | "child";
  conversation: {
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
  };
  metadata?: Record<string, unknown>;
};

type SpawnAction = typeof import("./action-spawn.js").handleSubagentsSpawnAction;

describe("/subagents spawn --thread", () => {
  let config: Record<string, unknown> = createSubagentSpawnTestConfig(os.tmpdir());
  let handleSubagentsSpawnAction: SpawnAction;

  beforeAll(async () => {
    await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      getSessionBindingService: () => ({
        getCapabilities: () => ({
          adapterAvailable: true,
          bindSupported: true,
          placements: ["current", "child"],
        }),
        bind: hoisted.bind,
        listBySession: () => [],
      }),
    });
    ({ handleSubagentsSpawnAction } = await import("./action-spawn.js"));
    const { setActivePluginRegistry } = await import("../../../plugins/runtime.js");
    const { createChannelTestPluginBase, createTestRegistry } =
      await import("../../../test-utils/channel-plugins.js");
    const resolveInboundConversation = ({ to, threadId }: { to?: string; threadId?: string }) => {
      const chat = to?.replace(/^[a-z]+:/, "");
      return chat
        ? threadId
          ? { conversationId: `${chat}:topic:${threadId}`, parentConversationId: chat }
          : { conversationId: chat }
        : null;
    };
    setActivePluginRegistry(
      createTestRegistry(
        (["telegram", "discord"] as const).map((id) => ({
          pluginId: id,
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id }),
            conversationBindings: { supportsCurrentConversationBinding: true },
            messaging: { resolveInboundConversation },
          },
        })),
      ),
    );
  });

  beforeEach(() => {
    config = createSubagentSpawnTestConfig(os.tmpdir());
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    // The channel creates a new topic or thread for child placement.
    hoisted.bind.mockReset().mockImplementation(async (input: BindInput) => ({
      bindingId: "binding-1",
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      status: "active",
      boundAt: 0,
      conversation: {
        channel: input.conversation.channel,
        accountId: input.conversation.accountId,
        conversationId: "new-thread",
        parentConversationId:
          input.conversation.parentConversationId ?? input.conversation.conversationId,
      },
      metadata: input.metadata,
    }));
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  function run(params: {
    channel: string;
    to: string;
    chatType: "group" | "channel" | "direct";
    threadId?: string;
    text?: string;
    assertOwnerCurrent?: () => void;
  }) {
    return handleSubagentsSpawnAction({
      requesterKey: "agent:main:main",
      restTokens: (params.text ?? "--thread Research the release notes").split(" "),
      params: {
        ctx: {
          ChatType: params.chatType,
          OriginatingChannel: params.channel,
          OriginatingTo: params.to,
          AccountId: "default",
          MessageThreadId: params.threadId,
        },
        command: {
          channel: params.channel,
          senderId: "user-1",
          assertOwnerCurrent: params.assertOwnerCurrent,
        },
      },
    } as never);
  }

  function replyText(result: unknown) {
    return (result as { reply?: { text?: string } }).reply?.text ?? "";
  }

  it.each([
    { name: "Telegram forum topic", channel: "telegram", to: "telegram:-1001234", threadId: "1" },
    { name: "Discord channel", channel: "discord", to: "channel:123", threadId: undefined },
  ])("$name: binds a new child thread owned by the user", async (scenario) => {
    const result = await run({ ...scenario, chatType: "group" });

    expect(replyText(result)).toContain("Started a subagent in a new thread");
    expect(hoisted.bind).toHaveBeenCalledTimes(1);
    const input = hoisted.bind.mock.calls[0]?.[0] as BindInput;
    expect(input).toMatchObject({ placement: "child", targetKind: "subagent" });
    expect(input.metadata?.boundBy).toBe("user-1");
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map(([call]) => call as { method?: string; params?: Record<string, unknown> })
      .find((call) => call.method === "agent");
    // The subagent answers in its own thread, not in the requester's conversation.
    expect(agentCall?.params?.deliver).toBe(true);
    expect(agentCall?.params?.to).toBe("channel:new-thread");
    expect(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]).toMatchObject({
      spawnMode: "session",
      expectsCompletionMessage: false,
    });
  });

  it("stops before the thread bind when owner authority is revoked during preparation", async () => {
    let checks = 0;
    const result = await run({
      channel: "discord",
      to: "channel:123",
      chatType: "group",
      assertOwnerCurrent: () => {
        checks += 1;
        if (checks > 1) {
          throw new Error("owner authority revoked");
        }
      },
    }).then(replyText, (error: unknown) => String(error));

    expect(result).toContain("owner authority revoked");
    expect(hoisted.bind).not.toHaveBeenCalled();
    const methods = hoisted.callGatewayMock.mock.calls.map(
      ([call]) => (call as { method?: string }).method,
    );
    expect(methods).not.toContain("agent");
  });

  it("passes live owner authority into the channel thread bind", async () => {
    let revoked = false;
    hoisted.bind.mockImplementationOnce(
      async (input: BindInput & { assertCurrent?: () => void }) => {
        // Ownership changes while the channel is about to create the thread.
        revoked = true;
        input.assertCurrent?.();
        throw new Error("bind must not continue after revocation");
      },
    );

    const result = await run({
      channel: "discord",
      to: "channel:123",
      chatType: "group",
      assertOwnerCurrent: () => {
        if (revoked) {
          throw new Error("owner authority revoked");
        }
      },
    }).then(replyText, (error: unknown) => String(error));

    expect(result).toContain("owner authority revoked");
    const methods = hoisted.callGatewayMock.mock.calls.map(
      ([call]) => (call as { method?: string }).method,
    );
    expect(methods).not.toContain("agent");
  });

  it("refuses in a direct chat and starts nothing", async () => {
    const result = await run({ channel: "telegram", to: "telegram:12345", chatType: "direct" });

    expect(replyText(result)).toContain("can't hold a new thread");
    expect(hoisted.bind).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("refuses when the channel cannot create a thread and removes the child", async () => {
    // The fork fixture carries no lifecycle revision, so exercise cleanup on an isolated child.
    config = createSubagentSpawnTestConfig(os.tmpdir(), {
      session: { threadBindings: { defaultSpawnContext: "isolated" } },
    });
    hoisted.bind.mockRejectedValueOnce(new Error("forum topics are not enabled"));

    const result = await run({ channel: "telegram", to: "telegram:-1009999", chatType: "group" });

    expect(replyText(result)).toContain("can't hold a new thread");
    const methods = hoisted.callGatewayMock.mock.calls.map(
      ([call]) => (call as { method?: string }).method,
    );
    expect(methods).not.toContain("agent");
    expect(methods).toContain("sessions.delete");
  });

  it("requires --thread and a task", async () => {
    const result = await run({
      channel: "discord",
      to: "channel:1",
      chatType: "group",
      text: "do it",
    });

    expect(replyText(result)).toContain("Usage: /subagents spawn --thread");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });
});
