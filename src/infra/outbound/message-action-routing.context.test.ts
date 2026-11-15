import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  createMessageActionContextFixture,
  directChatConfig,
  runDryAction,
  runDrySend,
  workspaceConfig,
} from "./message-action-runner.test-support.js";

const contextFixture = createMessageActionContextFixture();
const { handleForumAction, handleWorkspaceAction } = contextFixture;
const workspaceContext = {
  currentChannelId: "C12345678",
  currentChannelProvider: "workspace",
};
function runWorkspaceAction(
  input: Omit<Parameters<typeof runMessageAction>[0], "cfg"> & {
    cfg?: OpenClawConfig;
  },
) {
  return runMessageAction({ cfg: workspaceConfig, dryRun: false, ...input });
}
const crossProviderRestrictedConfig: OpenClawConfig = {
  ...workspaceConfig,
  tools: { message: { crossContext: { allowAcrossProviders: false } } },
};

describe("runMessageAction context isolation", () => {
  beforeEach(() => contextFixture.setup());
  afterEach(() => contextFixture.cleanup());
  it("uses the current conversation for an implicit read", async () => {
    await runWorkspaceAction({
      action: "read",
      params: {},
      defaultAccountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: workspaceContext,
    });

    expect(handleWorkspaceAction).toHaveBeenCalledOnce();
    expect(handleWorkspaceAction.mock.calls[0]?.[0]).toMatchObject({
      action: "read",
      params: { channel: "workspace", target: "C12345678", to: "C12345678" },
    });
  });

  it.each([
    {
      name: "accepts legacy to parameter for send",
      actionParams: { channel: "workspace", to: "#C12345678", message: "hi" },
    },
    {
      name: "allows media-only send when target matches current channel",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
  ])("$name", async ({ actionParams, toolContext }) => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams,
      ...(toolContext ? { toolContext } : {}),
    });

    expect(result.kind).toBe("send");
  });

  it("allows the active DM after target resolution strips its user prefix", async () => {
    const result = await runDrySend({
      cfg: {
        channels: { slackdm: {} },
        tools: { message: { crossContext: { allowWithinProvider: false } } },
      } as OpenClawConfig,
      actionParams: { channel: "slackdm", target: "user:U123", message: "hi" },
      toolContext: {
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        currentChannelProvider: "slackdm",
      },
    });

    expect(result).toMatchObject({ kind: "send", to: "U123" });
  });

  it("blocks cross-context UI handoff for thread-reply to another workspace channel", async () => {
    const result = await runDryAction({
      cfg: workspaceConfig,
      action: "thread-reply",
      actionParams: { channel: "workspace", target: "C99999999", message: "hi" },
      toolContext: workspaceContext,
    });
    expect(result.kind).toBe("action");
  });

  it.each([
    ["directchat", "456@g.us", "123@g.us"],
    ["localchat", "localchat:+15551230000", "localchat:+15551234567"],
  ] as const)("allows %s target mismatch", async (channel, target, currentChannelId) => {
    const result = await runDrySend({
      cfg: directChatConfig,
      actionParams: { channel, target, message: "hi" },
      toolContext: { currentChannelId, currentChannelProvider: channel },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "falls back to tool-context provider when channel param is an id",
      action: "send" as const,
      actionParams: { channel: "C12345678", target: "#C12345678", message: "hi" },
      toolContext: workspaceContext,
    },
    {
      name: "falls back to tool-context provider for broadcast channel ids",
      action: "broadcast" as const,
      actionParams: { targets: ["channel:C12345678"], channel: "C12345678", message: "hi" },
      toolContext: { currentChannelProvider: "workspace" },
    },
  ])("$name", async ({ action, actionParams, toolContext }) => {
    const result = await runDryAction({
      cfg: workspaceConfig,
      action,
      actionParams,
      toolContext,
    });

    expect(result).toMatchObject({ kind: action, channel: "workspace" });
  });

  it.each([
    {
      name: "blocks same-provider cross-context uploads when disabled",
      action: "upload-file" as const,
      cfg: {
        ...workspaceConfig,
        tools: { message: { crossContext: { allowWithinProvider: false } } },
      } as OpenClawConfig,
      actionParams: {
        channel: "workspace",
        target: "channel:C99999999",
        filePath: "/tmp/report.png",
      },
      toolContext: workspaceContext,
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks actions outside the per-agent allowlist",
      action: "channel-info" as const,
      cfg: {
        ...workspaceConfig,
        agents: {
          entries: {
            sandbox: {
              tools: { message: { actions: { allow: ["send"] } } },
            },
          },
        },
      } as OpenClawConfig,
      agentId: "sandbox",
      actionParams: { channel: "workspace", channelId: "C12345678" },
      message: 'Message action "channel-info" is disabled for this agent.',
    },
  ])("$name", async ({ action, cfg, actionParams, toolContext, message, agentId }) => {
    await expect(runDryAction({ cfg, action, actionParams, toolContext, agentId })).rejects.toThrow(
      message,
    );
  });

  it("dispatches topic actions for default cross-provider access", async () => {
    for (const action of ["topic-create", "topic-edit"] as const) {
      await expect(
        runWorkspaceAction({
          action,
          params: {
            channel: "forum",
            target: "@opsbot",
            name: "Allowed topic",
            ...(action === "topic-edit" ? { messageThreadId: "42" } : {}),
          },
          toolContext: workspaceContext,
        }),
      ).resolves.toMatchObject({ kind: "action", channel: "forum", action });
    }
    expect(handleForumAction).toHaveBeenCalledTimes(2);
  });

  it("retains direct-operator target-kind validation", async () => {
    const failure = runWorkspaceAction({
      action: "channel-info",
      params: { channel: "workspace", channelId: "U12345678" },
      conversationReadOrigin: "direct-operator",
      dryRun: true,
    });
    await expect(failure).rejects.toBeInstanceOf(MessageActionDeniedError);
    await expect(failure).rejects.toMatchObject({
      reasonCode: "message_target_invalid",
      policyRef: "message-target:valid",
    });
    await expect(failure).rejects.toThrow('Channel id "U12345678" resolved to a user target.');
  });

  it("retains direct-operator cross-provider reads", async () => {
    await expect(
      runWorkspaceAction({
        action: "read",
        params: { channel: "workspace", target: "C12345678" },
        defaultAccountId: "default",
        conversationReadOrigin: "direct-operator",
        toolContext: { currentChannelId: "forum-current", currentChannelProvider: "forum" },
      }),
    ).resolves.toMatchObject({ kind: "action", channel: "workspace", action: "read" });
    expect(handleWorkspaceAction).toHaveBeenCalledOnce();
  });

  it("retains explicit cross-provider restrictions for direct operators", async () => {
    await expect(
      runWorkspaceAction({
        cfg: crossProviderRestrictedConfig,
        action: "pin",
        params: {
          channel: "forum",
          target: "@opsbot",
          messageId: "forum-message-1",
        },
        conversationReadOrigin: "direct-operator",
        toolContext: workspaceContext,
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });
});
