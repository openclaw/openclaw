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

function createChannelPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  blurb: string;
  actions: string[];
  supportsButtons?: boolean;
  messaging?: ChannelPlugin["messaging"];
}): ChannelPlugin {
  return {
    id: params.id as ChannelPlugin["id"],
    meta: {
      id: params.id as ChannelPlugin["id"],
      label: params.label,
      selectionLabel: params.label,
      docsPath: params.docsPath,
      blurb: params.blurb,
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    ...(params.messaging ? { messaging: params.messaging } : {}),
    actions: {
      listActions: () => params.actions as never,
      ...(params.supportsButtons ? { supportsButtons: () => true } : {}),
    },
  };
}

async function executeSend(params: {
  action: Record<string, unknown>;
  toolOptions?: Partial<Parameters<typeof createMessageTool>[0]>;
}) {
  const tool = createMessageTool({
    config: {} as never,
    ...params.toolOptions,
  });
  await tool.execute("1", {
    action: "send",
    ...params.action,
  });
  return mocks.runMessageAction.mock.calls[0]?.[0] as
    | {
        params?: Record<string, unknown>;
        sandboxRoot?: string;
        requesterSenderId?: string;
      }
    | undefined;
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
  it.each([
    { field: "path", value: "~/Downloads/voice.ogg" },
    { field: "filePath", value: "./tmp/note.m4a" },
  ])("does not convert $field to media for send", async ({ field, value }) => {
    mockSendResult({ to: "telegram:123" });

    const call = await executeSend({
      action: {
        target: "telegram:123",
        [field]: value,
        message: "",
      },
    });

    expect(call?.params?.[field]).toBe(value);
    expect(call?.params?.media).toBeUndefined();
  });
});

describe("message tool schema scoping", () => {
  const telegramPlugin = createChannelPlugin({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    blurb: "Telegram test plugin.",
    actions: ["send", "react"],
    supportsButtons: true,
  });

  const discordPlugin = createChannelPlugin({
    id: "discord",
    label: "Discord",
    docsPath: "/channels/discord",
    blurb: "Discord test plugin.",
    actions: ["send", "poll"],
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each([
    {
      provider: "telegram",
      expectComponents: false,
      expectButtons: true,
      expectButtonStyle: true,
      expectedActions: ["send", "react", "poll"],
    },
    {
      provider: "discord",
      expectComponents: true,
      expectButtons: false,
      expectButtonStyle: false,
      expectedActions: ["send", "poll", "react"],
    },
  ])(
    "scopes schema fields for $provider",
    ({ provider, expectComponents, expectButtons, expectButtonStyle, expectedActions }) => {
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "telegram", source: "test", plugin: telegramPlugin },
          { pluginId: "discord", source: "test", plugin: discordPlugin },
        ]),
      );

      const tool = createMessageTool({
        config: {} as never,
        currentChannelProvider: provider,
      });
      const properties = getToolProperties(tool);
      const actionEnum = getActionEnum(properties);

      if (expectComponents) {
        expect(properties.components).toBeDefined();
      } else {
        expect(properties.components).toBeUndefined();
      }
      if (expectButtons) {
        expect(properties.buttons).toBeDefined();
      } else {
        expect(properties.buttons).toBeUndefined();
      }
      if (expectButtonStyle) {
        const buttonItemProps =
          (
            properties.buttons as {
              items?: { items?: { properties?: Record<string, unknown> } };
            }
          )?.items?.items?.properties ?? {};
        expect(buttonItemProps.style).toBeDefined();
      }
      for (const action of expectedActions) {
        expect(actionEnum).toContain(action);
      }
    },
  );
});

describe("message tool description", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  const bluebubblesPlugin = createChannelPlugin({
    id: "bluebubbles",
    label: "BlueBubbles",
    docsPath: "/channels/bluebubbles",
    blurb: "BlueBubbles test plugin.",
    actions: ["react", "renameGroup", "addParticipant", "removeParticipant", "leaveGroup"],
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
  });

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
  });

  it("includes other configured channels when currentChannel is set", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      actions: ["send", "react"],
    });

    const telegramPluginFull = createChannelPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram test plugin.",
      actions: ["send", "react", "delete", "edit", "topic-create"],
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "signal", source: "test", plugin: signalPlugin },
        { pluginId: "telegram", source: "test", plugin: telegramPluginFull },
      ]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    // Current channel actions are listed
    expect(tool.description).toContain("Current channel (signal) supports: react, send.");
    // Other configured channels are also listed
    expect(tool.description).toContain("Other configured channels:");
    expect(tool.description).toContain("telegram (delete, edit, react, send, topic-create)");
  });

  it("does not include 'Other configured channels' when only one channel is configured", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "bluebubbles", source: "test", plugin: bluebubblesPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "bluebubbles",
    });

    expect(tool.description).toContain("Current channel (bluebubbles) supports:");
    expect(tool.description).not.toContain("Other configured channels");
  });
});

describe("message tool reasoning tag sanitization", () => {
  it.each([
    {
      field: "text",
      input: "<think>internal reasoning</think>Hello!",
      expected: "Hello!",
      target: "signal:+15551234567",
      channel: "signal",
    },
    {
      field: "content",
      input: "<think>reasoning here</think>Reply text",
      expected: "Reply text",
      target: "discord:123",
      channel: "discord",
    },
    {
      field: "text",
      input: "Normal message without any tags",
      expected: "Normal message without any tags",
      target: "signal:+15551234567",
      channel: "signal",
    },
  ])(
    "sanitizes reasoning tags in $field before sending",
    async ({ channel, target, field, input, expected }) => {
      mockSendResult({ channel, to: target });

      const call = await executeSend({
        action: {
          target,
          [field]: input,
        },
      });
      expect(call?.params?.[field]).toBe(expected);
    },
  );
});

describe("message tool sandbox passthrough", () => {
  it.each([
    {
      name: "forwards sandboxRoot to runMessageAction",
      toolOptions: { sandboxRoot: "/tmp/sandbox" },
      expected: "/tmp/sandbox",
    },
    {
      name: "omits sandboxRoot when not configured",
      toolOptions: {},
      expected: undefined,
    },
  ])("$name", async ({ toolOptions, expected }) => {
    mockSendResult({ to: "telegram:123" });

    const call = await executeSend({
      toolOptions,
      action: {
        target: "telegram:123",
        message: "",
      },
    });
    expect(call?.sandboxRoot).toBe(expected);
  });

  it("forwards trusted requesterSenderId to runMessageAction", async () => {
    mockSendResult({ to: "discord:123" });

    const call = await executeSend({
      toolOptions: { requesterSenderId: "1234567890" },
      action: {
        target: "discord:123",
        message: "hi",
      },
    });

    expect(call?.requesterSenderId).toBe("1234567890");
  });
});
