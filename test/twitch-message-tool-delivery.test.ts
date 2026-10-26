import { afterEach, expect, it, vi } from "vitest";
import { twitchPlugin } from "../extensions/twitch/api.js";
import { isDeliveredMessagingToolResult } from "../src/agents/embedded-agent-message-tool-source-reply.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { TrustedMessageAuditEvent } from "../src/audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest } from "../src/audit/message-audit-events.test-support.js";
import { buildThreadingToolContext } from "../src/auto-reply/reply/agent-runner-utils.js";
import { formatMessageCliText } from "../src/commands/message-format.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { loadUnfinishedDeliveries } from "../src/infra/outbound/delivery-queue-storage.js";
import * as messageActionRunner from "../src/infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { onSessionTranscriptUpdate } from "../src/sessions/transcript-events.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});

const manager = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../extensions/twitch/src/client-manager-registry.js", () => ({
  getClientManager: () => manager,
  removeClientManager: vi.fn(),
}));

it.each<[string, boolean, string, string, ("sameSource" | "bareTarget" | "singleAccount")?]>([
  ["explicit current-source reply", true, "Hello source!", "Hello source!", "sameSource"],
  ["bare channel name", true, "Hello Twitch!", "Hello Twitch!", "bareTarget"],
  ["implicit no-send", false, "---", ""],
  ["explicit no-send", true, "---", ""],
  ["single implicit account", false, "Hello Twitch!", "Hello Twitch!", "singleAccount"],
  ["long Markdown", false, `**${"a".repeat(499)}😀b**`, `${"a".repeat(499)}😀b`],
  ["implicit source configured default", false, "**Hello** Twitch!", "Hello Twitch!"],
  ["explicit target override", true, "**Hello** Twitch!", "Hello Twitch!"],
  ["literal horizontal rule", false, "`---`", "---"],
])("sends %s", async (_name, explicit, message, expected, mode) => {
  await withOpenClawTestState({ prefix: "twitch-message-delivery-" }, async (state) => {
    const send = manager.sendMessage.mockReset();
    const singleAccount = mode === "singleAccount";
    const sameSource = mode === "sameSource";
    const bareTarget = mode === "bareTarget";
    const accountId = singleAccount ? "default" : explicit && !sameSource ? "other" : "secondary";
    const target = explicit && !sameSource ? "overridechannel" : "sourcechannel";
    const account = {
      username: "fixture-bot",
      clientId: "fixture-client",
      accessToken: "fixture-token",
      channel: "sourcechannel",
    };
    const accounts = { secondary: account, [accountId]: account };
    const cfg = {
      channels: { twitch: singleAccount ? account : { defaultAccount: "secondary", accounts } },
    };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "twitch", source: "test", plugin: twitchPlugin }]),
    );
    const sent = expected.length > 0;
    const custodyAtSend: Awaited<ReturnType<typeof loadUnfinishedDeliveries>>[] = [];
    send.mockImplementation(async () => {
      custodyAtSend.push(await loadUnfinishedDeliveries(state.stateDir));
      return { ok: true, messageId: "fixture-sent-1" };
    });
    const sessionKey = "agent:main:twitch:group:sourcechannel";
    const sourceAccountId = singleAccount ? "default" : "secondary";
    const sourceTarget = "twitch:channel:sourcechannel";
    const toolContext = buildThreadingToolContext({
      sessionCtx: { Provider: "twitch", To: sourceTarget, AccountId: sourceAccountId },
      config: cfg,
      hasRepliedRef: undefined,
    });
    const runAction = vi.spyOn(messageActionRunner, "runMessageAction");
    const tool = createMessageTool({
      config: cfg,
      agentId: "main",
      agentSessionKey: sessionKey,
      ...toolContext,
      sourceReplyDeliveryMode: "message_tool_only",
      workspaceDir: state.workspaceDir,
    });
    const args = {
      action: "send",
      message,
      ...(explicit
        ? {
            channel: "twitch",
            target: sameSource ? sourceTarget : bareTarget ? target : `#${target}`,
            accountId,
          }
        : {}),
    };
    const audits: TrustedMessageAuditEvent[] = [];
    const transcriptUpdated = vi.fn();
    const unsubscribeAudit = onTrustedMessageAuditEventForTest((event) => audits.push(event));
    const unsubscribeTranscript = onSessionTranscriptUpdate(transcriptUpdated);
    try {
      const result = await tool.execute("twitch-send", args);
      expect.soft(send).toHaveBeenCalledTimes(sent ? 1 : 0);
      if (sent) {
        expect.soft(send).toHaveBeenCalledWith(account, target, expected, cfg, accountId);
        const pendingDelivery = {
          channel: "twitch",
          ...(explicit ? { accountId } : {}),
          to: target,
          recoveryState: "send_attempt_started",
        };
        expect.soft(custodyAtSend).toEqual([[expect.objectContaining(pendingDelivery)]]);
        expect.soft(result.details).toMatchObject({
          deliveryStatus: "sent",
          messageDelivery: { status: "settled", primaryPlatformMessageId: "fixture-sent-1" },
        });
      } else {
        expect.soft(result.details).toMatchObject({
          deliveryStatus: "suppressed",
          suppressionReason: "adapter_returned_no_send",
          messageDelivery: { status: "suppressed" },
        });
      }
      expect.soft(transcriptUpdated).toHaveBeenCalledTimes(sent ? 1 : 0);
      expect.soft(isDeliveredMessagingToolResult({ args, result })).toBe(sent);
      const actionResult = await runAction.mock.results[0]?.value;
      expect
        .soft(formatMessageCliText(actionResult).join("\n"))
        .toContain(sent ? "fixture-sent-1" : "send suppressed: adapter_returned_no_send");
      const completed = audits.filter((e) => e.outcome === "sent" || e.outcome === "suppressed");
      const expectedAudit = sent
        ? { outcome: "sent", resultCount: 1 }
        : { outcome: "suppressed", resultCount: 0, reasonCode: "no_visible_payload" };
      expect.soft(completed).toEqual([expect.objectContaining(expectedAudit)]);
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    } finally {
      unsubscribeAudit();
      unsubscribeTranscript();
      runAction.mockRestore();
    }
  });
});
