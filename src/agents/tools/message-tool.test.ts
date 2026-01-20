import { describe, expect, it, vi } from "vitest";

import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createMessageTool } from "./message-tool.js";

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
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

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});

describe("message tool mirroring", () => {
  it("mirrors media filename for plugin-handled sends", async () => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      handledBy: "plugin",
      payload: {},
      dryRun: false,
    } satisfies MessageActionRunResult);

    const tool = createMessageTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "",
      media: "https://example.com/files/report.pdf?sig=1",
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: "report.pdf" }),
    );
  });

  it("does not mirror on dry-run", async () => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "telegram",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    } satisfies MessageActionRunResult);

    const tool = createMessageTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "hi",
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
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
