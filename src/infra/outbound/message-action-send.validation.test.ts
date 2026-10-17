import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  runDrySend as runFixtureDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-support.js";

const emptyConfig = {} as OpenClawConfig;
const portableLocation = { latitude: 48.858844, longitude: 2.294351 };
const target = { channel: "workspace", target: "#C12345678" };
const toolContext = { currentChannelId: "C12345678" };
const crossContext = { ...toolContext, currentChannelProvider: "workspace" };
const runDrySend = (actionParams: Record<string, unknown>, cross = false) =>
  runFixtureDrySend({
    cfg: workspaceConfig,
    actionParams: { ...target, ...actionParams },
    toolContext: cross ? crossContext : toolContext,
  });
const register = (...plugins: ChannelPlugin[]) =>
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
const runSend = (params: Record<string, unknown>) =>
  runMessageAction({ cfg: workspaceConfig, action: "send", params: { ...target, ...params } });

function captureWorkspaceSend(messageId = "workspace-test-message") {
  const sentText: string[] = [];
  register({
    ...workspaceTestPlugin,
    outbound: {
      ...workspaceTestPlugin.outbound,
      deliveryMode: "direct",
      sendText: async (ctx: ChannelOutboundContext) => {
        sentText.push(ctx.text);
        return { channel: "workspace", messageId };
      },
    },
  });
  return sentText;
}

describe("runMessageAction send validation", () => {
  beforeEach(() => register(workspaceTestPlugin));

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.restoreAllMocks();
  });
  it("requires message when no media hint is provided", async () => {
    await expect(runDrySend({})).rejects.toThrow(/message required/i);
  });

  it("allows send when only a portable location is provided", async () => {
    const result = await runDrySend({ location: portableLocation });

    expect(result.kind).toBe("send");
  });

  it.each([
    { name: "text", extra: { message: "caption" } },
    { name: "media", extra: { mediaUrl: "https://example.com/photo.jpg" } },
  ])(
    "rejects location sends mixed with $name before cross-context decoration",
    async ({ extra }) => {
      await expect(
        runDrySend({ target: "channel:C99999999", location: portableLocation, ...extra }, true),
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
      toolContext: crossContext,
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
    const sentText = captureWorkspaceSend();

    const result = await runSend({ message: "v2026.5.20 release note citeturn2view0" });

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
        message: '[tool:read] {"path":"/app/skills/meme-maker/SKILL.md"}',
      }),
    ).rejects.toThrow(/send requires text or media/i);
  });

  it.each([
    {
      name: "structured poll params",
      actionParams: {
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
      },
    },
    {
      name: "snake_case content poll params",
      actionParams: {
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(runDrySend(actionParams)).rejects.toThrow(/use action "poll" instead of "send"/i);
  });

  it("keeps rejecting a non-empty event location string on send", async () => {
    await expect(
      runDrySend({
        message: "hello",
        location: "Main stage",
      }),
    ).rejects.toThrow("location must be an object");
  });
  it.each([
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
    const sentText = captureWorkspaceSend("body-whitespace");
    const result = await runSend(body);
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
    register(workspaceTestPlugin);
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: { SendMessage },
      toolContext: { currentChannelProvider: "webchat" },
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
