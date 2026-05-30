import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  forumTestPlugin,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-helpers.js";

const emptyConfig = {} as OpenClawConfig;

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

  it("allows send when only presentation payloads are provided", async () => {
    const result = await runDrySend({
      cfg: {
        channels: {
          forum: {
            botToken: "forum-test",
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "forum",
        target: "123456",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only generic presentation blocks are provided", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        presentation: { blocks: [{ type: "divider" }] },
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("uses the current internal UI source as the message-tool-only send sink", async () => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        message: "hello from codex",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "webchat",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "hello from codex",
        },
      },
    });
    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.toolResult?.content).toEqual([
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ]);
    expect(result.toolResult?.details).toEqual({
      status: "ok",
      deliveryStatus: "sent",
      channel: "webchat",
      target: "current-run",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplySink: "internal-ui",
      sourceReply: {
        text: "hello from codex",
      },
      message: "hello from codex",
      dryRun: false,
    });
    expect(JSON.stringify(result.toolResult?.content)).not.toContain("hello from codex");
  });

  it("strips unsupported citation control markers from internal UI source replies", async () => {
    const result = await runMessageAction({
      cfg: emptyConfig,
      action: "send",
      params: {
        message: "v2026.5.20 release note citeturn2view0",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      payload: {
        sourceReply: {
          text: "v2026.5.20 release note",
        },
      },
    });
    expect(JSON.stringify(result.payload)).not.toContain("turn2view0");
  });

  it("keeps implicit current-channel text sends on the source reply path during message-tool-only delivery", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        message: "visible answer",
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "visible answer",
        },
      },
    });
  });

  it("keeps provider-only source text sends on the source reply path during message-tool-only delivery", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        message: "visible answer",
      },
      toolContext: {
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: {
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "visible answer",
        },
      },
    });
  });

  it("keeps message-tool-only current-channel text sends on outbound path without an internal source consumer", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        message: "visible answer",
        dryRun: true,
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      handledBy: "core",
      dryRun: true,
    });
  });

  it("does not infer an internal UI sink outside message-tool-only source delivery", async () => {
    await expect(
      runMessageAction({
        cfg: emptyConfig,
        action: "send",
        params: {
          message: "hello from codex",
        },
        toolContext: {
          currentChannelProvider: "webchat",
        },
        sessionKey: "agent:main",
        sourceReplyDeliveryMode: "automatic",
      }),
    ).rejects.toThrow(/requires a target/i);
  });

  it("keeps implicit current-channel text sends on the normal outbound path without an internal source consumer", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        message: "visible answer",
        dryRun: true,
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "automatic",
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      handledBy: "core",
      dryRun: true,
    });
  });

  it("keeps implicit current-channel text sends on the source reply path during automatic delivery", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        message: "visible answer",
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "automatic",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplyDeliveryMode: "automatic",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "visible answer",
        },
      },
    });
  });

  it("treats omitted source delivery mode as automatic when an internal source consumer is present", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        message: "visible answer",
      },
      toolContext: {
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      to: "current-run",
      handledBy: "internal-source",
      dryRun: false,
      payload: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplyDeliveryMode: "automatic",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "visible answer",
        },
      },
    });
  });

  it.each([
    { name: "silent false", actionParams: { message: "visible answer", silent: false } },
    { name: "asVoice false", actionParams: { message: "visible answer", asVoice: false } },
    {
      name: "snake_case voice false",
      actionParams: { message: "visible answer", as_voice: "false" },
    },
    {
      name: "forceDocument false",
      actionParams: { message: "visible answer", forceDocument: false },
    },
    { name: "gifPlayback false", actionParams: { message: "visible answer", gifPlayback: false } },
    { name: "pin false", actionParams: { message: "visible answer", pin: false } },
    { name: "topLevel false", actionParams: { message: "visible answer", topLevel: false } },
    {
      name: "replyBroadcast false",
      actionParams: { message: "visible answer", replyBroadcast: false },
    },
    {
      name: "idempotency key",
      actionParams: { message: "visible answer", idempotencyKey: "run-1:message-tool:1" },
    },
  ])(
    "keeps implicit current-channel text sends with no-op $name on the source reply path",
    async ({ actionParams }) => {
      const result = await runMessageAction({
        cfg: workspaceConfig,
        action: "send",
        params: actionParams,
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "workspace",
        },
        sessionKey: "agent:main",
        sourceReplyDeliveryMode: "automatic",
        allowInternalSourceReplySink: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        channel: "workspace",
        to: "current-run",
        handledBy: "internal-source",
        payload: {
          sourceReplyDeliveryMode: "automatic",
          sourceReplySink: "internal-ui",
          sourceReply: {
            text: "visible answer",
          },
        },
      });
    },
  );

  it("keeps explicit same-channel text sends on the source reply path during automatic delivery", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        channel: "workspace",
        message: "visible answer",
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "automatic",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      to: "current-run",
      handledBy: "internal-source",
      payload: {
        sourceReplyDeliveryMode: "automatic",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "visible answer",
        },
      },
    });
  });

  it("keeps explicit same-channel aliases on the source reply path during automatic delivery", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            ...workspaceTestPlugin,
            meta: {
              ...workspaceTestPlugin.meta,
              aliases: ["workspace-chat"],
            },
          },
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        channel: "workspace-chat",
        message: "visible answer",
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "automatic",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      to: "current-run",
      handledBy: "internal-source",
      payload: {
        sourceReplyDeliveryMode: "automatic",
        sourceReplySink: "internal-ui",
        sourceReply: {
          text: "visible answer",
        },
      },
    });
  });

  it("does not treat a different explicit channel as a current-source reply", async () => {
    await expect(
      runMessageAction({
        cfg: {
          channels: {
            workspace: {
              botToken: "workspace-test",
              appToken: "workspace-app-test",
            },
            forum: {
              botToken: "forum-test",
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "forum",
          message: "visible answer",
          dryRun: true,
        },
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "workspace",
        },
        sessionKey: "agent:main",
        sourceReplyDeliveryMode: "automatic",
        allowInternalSourceReplySink: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });

  it("keeps explicit current-channel sends on the normal outbound path in automatic mode", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        target: "#C12345678",
        message: "visible answer",
        dryRun: true,
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "automatic",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      handledBy: "core",
      dryRun: true,
    });
  });

  it("allows implicit current-channel media sends during automatic source delivery", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        media: "https://example.com/report.png",
        dryRun: true,
      },
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "automatic",
      allowInternalSourceReplySink: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      handledBy: "core",
      dryRun: true,
    });
  });

  it.each([
    {
      name: "base64 media hint",
      actionParams: {
        message: "visible answer",
        base64: "AAAA",
        dryRun: true,
      },
    },
    {
      name: "image media hint",
      actionParams: {
        message: "visible answer",
        image: "https://example.com/report.png",
        dryRun: true,
      },
    },
    {
      name: "reply threading",
      actionParams: {
        message: "visible answer",
        replyTo: "msg-42",
        dryRun: true,
      },
    },
    {
      name: "top-level thread control",
      actionParams: {
        message: "visible answer",
        topLevel: true,
        dryRun: true,
      },
    },
    {
      name: "null thread control",
      actionParams: {
        message: "visible answer",
        threadId: null,
        dryRun: true,
      },
    },
    {
      name: "Slack reply broadcast",
      actionParams: {
        message: "visible answer",
        replyBroadcast: true,
        dryRun: true,
      },
    },
    {
      name: "snake_case reply broadcast",
      actionParams: {
        message: "visible answer",
        reply_broadcast: true,
        dryRun: true,
      },
    },
    {
      name: "voice delivery option",
      actionParams: {
        message: "visible answer",
        asVoice: true,
        dryRun: true,
      },
    },
    {
      name: "silent delivery option",
      actionParams: {
        message: "visible answer",
        silent: true,
        dryRun: true,
      },
    },
    {
      name: "string voice delivery option",
      actionParams: {
        message: "visible answer",
        asVoice: "true",
        dryRun: true,
      },
    },
    {
      name: "snake_case media URL hint",
      actionParams: {
        message: "visible answer",
        media_url: "https://example.com/report.png",
        dryRun: true,
      },
    },
    {
      name: "snake_case reply threading",
      actionParams: {
        message: "visible answer",
        reply_to: "msg-42",
        dryRun: true,
      },
    },
    {
      name: "snake_case voice delivery option",
      actionParams: {
        message: "visible answer",
        as_voice: true,
        dryRun: true,
      },
    },
    {
      name: "required delivery option",
      actionParams: {
        message: "visible answer",
        bestEffort: false,
        dryRun: true,
      },
    },
    {
      name: "delivery pin option",
      actionParams: {
        message: "visible answer",
        delivery: { pin: { enabled: true } },
        dryRun: true,
      },
    },
    {
      name: "plugin-owned send option",
      actionParams: {
        message: "visible answer",
        workspaceComponent: "summary-card",
        dryRun: true,
      },
    },
  ])(
    "keeps implicit current-channel sends with $name on the normal outbound path",
    async ({ actionParams }) => {
      const result = await runMessageAction({
        cfg: workspaceConfig,
        action: "send",
        params: actionParams,
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "workspace",
        },
        sessionKey: "agent:main",
        sourceReplyDeliveryMode: "automatic",
        allowInternalSourceReplySink: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        channel: "workspace",
        handledBy: "core",
        dryRun: true,
      });
    },
  );

  it("keeps explicit message routes on the normal outbound path", async () => {
    const result = await runMessageAction({
      cfg: workspaceConfig,
      action: "send",
      params: {
        channel: "workspace",
        target: "#C12345678",
        message: "hello from codex",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
      sessionKey: "agent:main",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "workspace",
      handledBy: "core",
      dryRun: true,
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
      name: "string-encoded poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: "60",
        pollPublic: "true",
      },
    },
    {
      name: "snake_case poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
    {
      name: "negative poll duration params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: -5,
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
    { alias: "SendMessage", value: "hello from alias" },
    { alias: "content", value: "hello from content" },
    { alias: "text", value: "hello from text" },
  ])("normalizes $alias alias to message for send", async ({ alias, value }) => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        [alias]: value,
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("does not overwrite an explicit message with an alias", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "explicit",
        SendMessage: "alias value",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("emits a diagnostic warning when normalizing an alias", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        SendMessage: "alias body",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[message-tool] normalized alias "SendMessage" to "message"'),
    );
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
      sessionKey: "agent:main",
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

  it("still rejects send with no message and no alias", async () => {
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
});
