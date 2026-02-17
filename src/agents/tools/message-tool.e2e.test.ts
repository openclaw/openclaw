import { describe, expect, it, vi } from "vitest";
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

describe("message tool agent routing", () => {
  it("derives agentId from the session key", async () => {
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      to: "telegram:123",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      to: "telegram:123",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "signal",
      to: "signal:+15551234567",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "discord",
      to: "discord:123",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "signal",
      to: "signal:+15551234567",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      to: "telegram:123",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
    mocks.runMessageAction.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      to: "telegram:123",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

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
});
