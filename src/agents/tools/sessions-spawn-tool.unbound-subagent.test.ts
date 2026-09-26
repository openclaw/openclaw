// Agent-started subagents never bind a chat: sessions_spawn thread requests run
// unbound and still report back to the requester through announce delivery.
import os from "node:os";
import { Value } from "typebox/value";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "../test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  bind: vi.fn(),
}));

type CreateTool = typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
type BindInput = {
  targetSessionKey: string;
  targetKind: string;
  conversation: Record<string, unknown>;
};

describe("sessions_spawn subagent thread requests", () => {
  let createSessionsSpawnTool: CreateTool;
  let spawnSubagentDirect: Awaited<
    ReturnType<typeof loadSubagentSpawnModuleForTest>
  >["spawnSubagentDirect"];
  const config: OpenClawConfig = {
    session: { mainKey: "main", scope: "per-sender", threadBindings: { enabled: true } },
    agents: { defaults: { workspace: os.tmpdir() } },
  };

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
    }));
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
    // Real binding service with adapters offering every placement, so any
    // remaining agent binding path would reach bind().
    const { registerSessionBindingAdapter } =
      await import("../../infra/outbound/session-binding-service.js");
    for (const channel of ["telegram", "discord"]) {
      registerSessionBindingAdapter({
        channel,
        accountId: "default",
        capabilities: { placements: ["current", "child"] },
        bind: hoisted.bind,
        listBySession: () => [],
        resolveByConversation: () => null,
        unbind: async () => [],
      });
    }
    const { setActivePluginRegistry } = await import("../../plugins/runtime.js");
    const { createChannelTestPluginBase, createTestRegistry } =
      await import("../../test-utils/channel-plugins.js");
    const resolveInboundConversation = ({ to, threadId }: { to?: string; threadId?: string }) => {
      const chat = to?.replace(/^[a-z]+:/, "");
      if (!chat) {
        return null;
      }
      return threadId
        ? { conversationId: `${chat}:topic:${threadId}`, parentConversationId: chat }
        : { conversationId: chat };
    };
    setActivePluginRegistry(
      createTestRegistry(
        (
          [
            ["telegram", "current"],
            ["discord", "child"],
          ] as const
        ).map(([id, placement]) => ({
          pluginId: id,
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id }),
            conversationBindings: {
              defaultTopLevelPlacement: placement,
              supportsCurrentConversationBinding: true,
            },
            messaging: { resolveInboundConversation },
          },
        })),
      ),
    );
  });

  beforeEach(() => {
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    // A working adapter: a remaining agent binding path would take over the chat.
    hoisted.bind.mockReset().mockImplementation(async (input: BindInput) => ({
      bindingId: "takeover",
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      status: "active",
      boundAt: 0,
      conversation: input.conversation,
    }));
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  it.each([
    {
      name: "Telegram forum topic (binds current conversation)",
      channel: "telegram",
      to: "telegram:-1001234567890",
      threadId: 1,
      args: { thread: true },
    },
    {
      name: "Telegram DM with legacy session mode",
      channel: "telegram",
      to: "telegram:12345",
      threadId: undefined,
      args: { thread: true, mode: "session" },
    },
    {
      name: "Discord channel (creates child thread)",
      channel: "discord",
      to: "channel:123",
      threadId: undefined,
      args: { thread: true, mode: "session" },
    },
  ])("$name runs unbound and announces back to the requester", async (scenario) => {
    const requesterSessionKey = `agent:main:${scenario.channel}:group:chat`;
    const tool = createSessionsSpawnTool({
      config,
      agentSessionKey: requesterSessionKey,
      agentChannel: scenario.channel,
      agentAccountId: "default",
      agentTo: scenario.to,
      agentThreadId: scenario.threadId,
    });

    const result = await tool.execute("call-thread", {
      task: "Recall the shared memory note",
      label: "Shared-memory recall test",
      ...scenario.args,
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("accepted");
    expect(details.mode).toBe("run");
    expect(details.note).toMatch(/Subagents cannot own conversation bindings/);
    expect(hoisted.bind).not.toHaveBeenCalled();

    const agentCall = hoisted.callGatewayMock.mock.calls
      .map(([call]) => call as { method?: string; params?: Record<string, unknown> })
      .find((call) => call.method === "agent");
    expect(agentCall?.params?.deliver).toBe(false);

    // The registered run owns completion: announce back to the requester's chat.
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]).toMatchObject({
      requesterSessionKey,
      expectsCompletionMessage: true,
      spawnMode: "run",
      requesterOrigin: {
        channel: scenario.channel,
        to: scenario.to,
        ...(scenario.threadId === undefined ? {} : { threadId: scenario.threadId }),
      },
    });
  });

  it("keeps thread binding out of the subagent tool surface", () => {
    const tool = createSessionsSpawnTool({
      config,
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentTo: "telegram:-1001234567890",
    });
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(properties.thread).toBeUndefined();
    expect(properties.mode).toMatchObject({ enum: ["run", "session"] });
    // Older callers still validate against the schema before the tool runs.
    expect(Value.Check(tool.parameters, { task: "x", mode: "session", thread: true })).toBe(true);
    expect(tool.description).toContain("never bind or take over a chat");
  });

  it("cannot recover direct-core binding with retired command-only fields", async () => {
    const retiredRequest = {
      task: "Run in the background",
      thread: true,
      mode: "session",
      childThread: { boundBy: "owner" },
    };
    const result = await spawnSubagentDirect(retiredRequest, {
      agentSessionKey: "agent:main:telegram:group:chat",
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:-1001234567890",
      agentThreadId: 1,
    });
    expect(result.status).toBe("accepted");
    expect(result.mode).toBe("run");
    expect(hoisted.bind).not.toHaveBeenCalled();
    const launch = hoisted.callGatewayMock.mock.calls
      .map(([call]) => call as { method?: string; params?: Record<string, unknown> })
      .find((call) => call.method === "agent");
    expect(launch?.params?.deliver).toBe(false);
  });
});
