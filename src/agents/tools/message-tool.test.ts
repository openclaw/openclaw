import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createMessageTool } from "./message-tool.js";

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
}));

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

function mockSendResult(overrides: { channel?: string; to?: string } = {}) {
  mocks.runMessageAction.mockClear();
  mocks.runMessageAction.mockResolvedValue({
    kind: "send",
    action: "send",
    channel: overrides.channel ?? "telegram",
    to: overrides.to ?? "telegram:123",
    handledBy: "plugin",
    payload: {},
    dryRun: true,
  } satisfies MessageActionRunResult);
}

function getToolProperties(tool: ReturnType<typeof createMessageTool>) {
  return (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
}

function getActionEnum(properties: Record<string, unknown>) {
  return (properties.action as { enum?: string[] } | undefined)?.enum ?? [];
}

describe("message tool agent routing", () => {
  it("derives agentId from the session key", async () => {
    mockSendResult();

    const tool = createMessageTool({
      agentSessionKey: "agent:alpha:main",
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "hi",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.agentId).toBe("alpha");
    expect(call?.sessionKey).toBe("agent:alpha:main");
  });
});

describe("message tool path passthrough", () => {
  it("does not convert path to media for send", async () => {
    mockSendResult({ to: "telegram:123" });

    const tool = createMessageTool({
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      path: "~/Downloads/voice.ogg",
      message: "",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.params?.path).toBe("~/Downloads/voice.ogg");
    expect(call?.params?.media).toBeUndefined();
  });

  it("does not convert filePath to media for send", async () => {
    mockSendResult({ to: "telegram:123" });

    const tool = createMessageTool({
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      filePath: "./tmp/note.m4a",
      message: "",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.params?.filePath).toBe("./tmp/note.m4a");
    expect(call?.params?.media).toBeUndefined();
  });
});

describe("message tool schema scoping", () => {
  const telegramPlugin: ChannelPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram test plugin.",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    actions: {
      listActions: () => ["send", "react"] as const,
      supportsButtons: () => true,
    },
  };

  const discordPlugin: ChannelPlugin = {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord test plugin.",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    actions: {
      listActions: () => ["send", "poll"] as const,
    },
  };

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("hides discord components when scoped to telegram", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
        { pluginId: "discord", source: "test", plugin: discordPlugin },
      ]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });
    const properties = getToolProperties(tool);
    const actionEnum = getActionEnum(properties);

    expect(properties.components).toBeUndefined();
    expect(properties.buttons).toBeDefined();
    const buttonItemProps =
      (
        properties.buttons as {
          items?: { items?: { properties?: Record<string, unknown> } };
        }
      )?.items?.items?.properties ?? {};
    expect(buttonItemProps.style).toBeDefined();
    expect(actionEnum).toContain("send");
    expect(actionEnum).toContain("react");
    expect(actionEnum).not.toContain("poll");
  });

  it("shows discord components when scoped to discord", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
        { pluginId: "discord", source: "test", plugin: discordPlugin },
      ]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
    });
    const properties = getToolProperties(tool);
    const actionEnum = getActionEnum(properties);

    expect(properties.components).toBeDefined();
    expect(properties.buttons).toBeUndefined();
    expect(actionEnum).toContain("send");
    expect(actionEnum).toContain("poll");
    expect(actionEnum).not.toContain("react");
  });
});

describe("message tool description", () => {
  const bluebubblesPlugin: ChannelPlugin = {
    id: "bluebubbles",
    meta: {
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles",
      docsPath: "/channels/bluebubbles",
      blurb: "BlueBubbles test plugin.",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    messaging: {
      normalizeTarget: (raw) => {
        const trimmed = raw.trim().replace(/^bluebubbles:/i, "");
        const lower = trimmed.toLowerCase();
        if (lower.startsWith("chat_guid:")) {
          const guid = trimmed.slice("chat_guid:".length);
          const parts = guid.split(";");
          if (parts.length === 3 && parts[1] === "-") {
            return parts[2]?.trim() || trimmed;
          }
          return `chat_guid:${guid}`;
        }
        return trimmed;
      },
    },
    actions: {
      listActions: () =>
        ["react", "renameGroup", "addParticipant", "removeParticipant", "leaveGroup"] as const,
    },
  };

  it("hides BlueBubbles group actions for DM targets", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "bluebubbles", source: "test", plugin: bluebubblesPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "bluebubbles",
      currentChannelId: "bluebubbles:chat_guid:iMessage;-;+15551234567",
    });

    expect(tool.description).not.toContain("renameGroup");
    expect(tool.description).not.toContain("addParticipant");
    expect(tool.description).not.toContain("removeParticipant");
    expect(tool.description).not.toContain("leaveGroup");

    setActivePluginRegistry(createTestRegistry([]));
  });
});

describe("message tool reasoning tag sanitization", () => {
  it("strips <think> tags from text field before sending", async () => {
    mockSendResult({ channel: "signal", to: "signal:+15551234567" });

    const tool = createMessageTool({ config: {} as never });

    await tool.execute("1", {
      action: "send",
      target: "signal:+15551234567",
      text: "<think>internal reasoning</think>Hello!",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.params?.text).toBe("Hello!");
  });

  it("strips <think> tags from content field before sending", async () => {
    mockSendResult({ channel: "discord", to: "discord:123" });

    const tool = createMessageTool({ config: {} as never });

    await tool.execute("1", {
      action: "send",
      target: "discord:123",
      content: "<think>reasoning here</think>Reply text",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.params?.content).toBe("Reply text");
  });

  it("passes through text without reasoning tags unchanged", async () => {
    mockSendResult({ channel: "signal", to: "signal:+15551234567" });

    const tool = createMessageTool({ config: {} as never });

    await tool.execute("1", {
      action: "send",
      target: "signal:+15551234567",
      text: "Normal message without any tags",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.params?.text).toBe("Normal message without any tags");
  });
});

describe("message tool sandbox passthrough", () => {
  it("forwards sandboxRoot to runMessageAction", async () => {
    mockSendResult({ to: "telegram:123" });

    const tool = createMessageTool({
      config: {} as never,
      sandboxRoot: "/tmp/sandbox",
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.sandboxRoot).toBe("/tmp/sandbox");
  });

  it("omits sandboxRoot when not configured", async () => {
    mockSendResult({ to: "telegram:123" });

    const tool = createMessageTool({
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.sandboxRoot).toBeUndefined();
  });

  it("forwards trusted requesterSenderId to runMessageAction", async () => {
    mockSendResult({ to: "discord:123" });

    const tool = createMessageTool({
      config: {} as never,
      requesterSenderId: "1234567890",
    });

    await tool.execute("1", {
      action: "send",
      target: "discord:123",
      message: "hi",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.requesterSenderId).toBe("1234567890");
  });
});
