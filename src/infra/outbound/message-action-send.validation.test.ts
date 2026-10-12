// Covers send validation for target/channel mismatches, configured channel
// availability, and explicit target requirements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type * as ConfirmedVisibleMessage from "../../sessions/background-session-result.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  forumTestPlugin,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-support.js";

// Keep input-validation tests independent of destination session storage.
vi.mock("../../sessions/background-session-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfirmedVisibleMessage>()),
  commitConfirmedVisibleMessage: vi.fn(async () => ({ ok: true })),
}));

const emptyConfig = {} as OpenClawConfig;
const portableLocation = { latitude: 48.858844, longitude: 2.294351 };
describe("runMessageAction send validation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspaceTestPlugin,
        },
        {
          pluginId: "forum",
          source: "test",
          plugin: forumTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });
  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("allows send when only a portable location is provided", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        location: { latitude: 48.858844, longitude: 2.294351 },
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    { name: "text", extra: { message: "caption" } },
    { name: "media", extra: { mediaUrl: "https://example.com/photo.jpg" } },
  ])(
    "rejects location sends mixed with $name before cross-context decoration",
    async ({ extra }) => {
      await expect(
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "channel:C99999999",
            location: { latitude: 48.858844, longitude: 2.294351 },
            ...extra,
          },
          toolContext: {
            currentChannelId: "C12345678",
            currentChannelProvider: "workspace",
          },
        }),
      ).rejects.toThrow(/cannot be combined/i);
    },
  );

  it.each([
    { name: "text", content: { message: "hello" } },
    { name: "image", content: { image: "https://example.com/photo.jpg" } },
    { name: "buffer media", content: { buffer: "aGVsbG8=", filename: "hello.txt" } },
  ])("repairs incidental location for model-authored $name sends", async ({ content }) => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      actionOrigin: "message-tool",
      params: {
        channel: "workspace",
        target: "channel:C99999999",
        ...content,
        location: portableLocation,
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      dryRun: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      action: "send",
      normalization: { locationOmitted: true },
    });
    expect(result.kind === "send" ? result.payload : undefined).not.toMatchObject({
      location: expect.anything(),
    });
  });
  it("strips unsupported citation control markers from normal channel sends", async () => {
    const sentText: string[] = [];
    const sendText: NonNullable<
      NonNullable<typeof workspaceTestPlugin.outbound>["sendText"]
    > = async (ctx) => {
      sentText.push(ctx.text);
      return { channel: "workspace", messageId: "workspace-test-message" };
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            ...workspaceTestPlugin,
            outbound: {
              ...workspaceTestPlugin.outbound,
              sendText,
            },
          },
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        channel: "workspace",
        target: "#C12345678",
        message: "v2026.5.20 release note citeturn2view0",
      },
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
    });
    expect(sentText).toEqual(["v2026.5.20 release note"]);
    expect(JSON.stringify(result.payload)).not.toContain("turn2view0");
  });

  it("rejects message sends whose body is only leaked plain-text tool calls", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: '[tool:read] {"path":"/app/skills/meme-maker/SKILL.md"}',
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/send requires text or media/i);
  });

  it.each([
    {
      name: "structured poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
      },
    },
    {
      name: "snake_case content poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });

  it("keeps rejecting a non-empty event location string on send", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: "hello",
          location: "Main stage",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow("location must be an object");
  });
});
describe("message body alias normalization", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspaceTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.restoreAllMocks();
  });

  it.each([
    { name: "canonical message", body: { message: "    indented body" } },
    {
      name: "mixed reasoning preamble alias",
      body: { text: "<think>private</think>\nThinking\n_summary_\n    indented body" },
    },
    {
      name: "blank earlier alias",
      body: { SendMessage: " \n\t ", content: "    indented body", text: "not selected" },
    },
    { name: "caption fallback", body: { message: "", caption: "    indented body" } },
  ])("delivers code indentation through $name", async ({ body }) => {
    const sentText: string[] = [];
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            ...workspaceTestPlugin,
            outbound: {
              ...workspaceTestPlugin.outbound,
              sendText: async (ctx: ChannelOutboundContext) => {
                sentText.push(ctx.text);
                return { channel: "workspace", messageId: "body-whitespace" };
              },
            },
          },
        },
      ]),
    );
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: { channel: "workspace", target: "#C12345678", ...body },
    });
    expect(result.kind).toBe("send");
    expect(sentText).toEqual(["    indented body"]);
  });

  it.each([
    {
      name: "reasoning tag",
      SendMessage: "<think>internal reasoning</think>Visible answer",
    },
    {
      name: "formatted reasoning prefix",
      SendMessage: "Reasoning:\n_internal plan_\n\nVisible answer",
    },
  ])("sanitizes SendMessage alias $name before delivery", async ({ SendMessage }) => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        SendMessage,
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      payload: {
        sourceReply: {
          text: "Visible answer",
        },
      },
    });
  });
});
