import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  createMessageActionContextFixture,
  runDryAction,
  runDrySend,
  workspaceConfig,
} from "./message-action-runner.test-support.js";

const contextFixture = createMessageActionContextFixture();
const { handleWorkspaceAction } = contextFixture;
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
