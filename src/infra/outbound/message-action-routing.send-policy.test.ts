import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentRestartRecoveryContext } from "../../gateway/agent-turn/agent-restart-recovery-context.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import { runMessageAction } from "./message-action-runner.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

const slackConfig: OpenClawConfig = { channels: { slack: { enabled: true } } };
const sourceContext = { currentChannelProvider: "slack", currentChannelId: "channel:C123" };
type SendInput = Omit<Parameters<typeof runMessageAction>[0], "action" | "cfg"> & {
  cfg?: OpenClawConfig;
};
function runSend(input: SendInput) {
  return runMessageAction({ cfg: slackConfig, action: "send", dryRun: false, ...input });
}
function runSourceSend(input: SendInput) {
  return runSend({
    toolContext: sourceContext,
    sessionKey: "agent:main:slack:channel:C123",
    sourceReplyDeliveryMode: "message_tool_only",
    ...input,
  });
}
function registerPlugin(
  params: Parameters<typeof createOutboundTestPlugin>[0],
  overrides: Partial<ChannelPlugin> = {},
) {
  const plugin = { ...createOutboundTestPlugin(params), ...overrides };
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
}

function registerSlackTextPlugin(accountIds: string[] = ["default"]) {
  const sendText = vi.fn().mockResolvedValue({ channel: "slack", messageId: "m1", chatId: "C123" });
  registerPlugin(
    { id: "slack", outbound: { deliveryMode: "direct", sendText } },
    {
      config: {
        listAccountIds: () => accountIds,
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      threading: { threadAddressing: "message" },
    },
  );
  return sendText;
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });

  it.each([
    { name: "agent opt-in", global: false, agent: true, allowed: true },
    { name: "agent restriction", global: true, agent: false, allowed: false },
  ])("preserves $name for targetless recovery", async (policy) => {
    const sendText = registerSlackTextPlugin();
    const cfg: OpenClawConfig = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowAcrossProviders: policy.global } },
      },
      agents: {
        entries: {
          main:
            policy.agent === undefined
              ? {}
              : {
                  tools: { message: { crossContext: { allowAcrossProviders: policy.agent } } },
                },
        },
      },
    };
    const recovery = resolveAgentRestartRecoveryContext({
      isRestartRecoveryResumeRun: true,
      canUseInternalRuntimeHandoff: true,
      expectedExistingSessionId: "session-1",
      resolvedSessionId: "session-1",
      resolvedSessionKey: "agent:main:dashboard:recovery",
      runId: "recovery-run",
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "source-run",
        restartRecoverySourceIngress: "control-ui",
      },
    });
    expect(recovery?.messageChannel).toBe("webchat");
    expect(recovery?.channel).toBeUndefined();

    const send = runSend({
      cfg,
      agentId: "main",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "synthetic recovery policy probe",
        bestEffort: true,
      },
      toolContext: { currentChannelProvider: recovery?.messageChannel },
    });
    if (!policy.allowed) {
      await expect(send).rejects.toMatchObject({
        reasonCode: "message_cross_context_denied",
        policyRef: "message-cross-context:provider",
      });
      expect(sendText).not.toHaveBeenCalled();
      return;
    }
    await expect(send).resolves.toMatchObject({
      kind: "send",
      channel: "slack",
      to: "channel:C123",
    });
    expect(sendText).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      to: "channel:C123",
      text: "synthetic recovery policy probe",
    });
  });

  it("accepts Telegram numeric forum topic targets through plugin-owned grammar", async () => {
    registerPlugin({
      id: "telegram",
      outbound: { deliveryMode: "direct", sendText: vi.fn() },
      messaging: {
        normalizeTarget: (raw) =>
          raw === "-1001234567890:topic:42" ? "telegram:-1001234567890:topic:42" : undefined,
        targetResolver: { looksLikeId: (raw) => raw === "-1001234567890:topic:42" },
      },
    });

    const result = await runSend({
      cfg: { channels: { telegram: { botToken: "123:test" } } },
      params: {
        channel: "telegram",
        target: "-1001234567890:topic:42",
        message: "topic hello",
      },
      dryRun: true,
    });

    expect(result).toMatchObject({
      kind: "send",
      to: "telegram:-1001234567890:topic:42",
      payload: { to: "telegram:-1001234567890:topic:42", dryRun: true },
    });
  });

  it("uses best-effort delivery for implicit message-tool-only source replies", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runSourceSend({
      params: { message: "visible source reply", bestEffort: false },
    });

    expect(result.kind).toBe("send");
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("rejects implicit delivery to an internal session before sending", async () => {
    const sendText = registerSlackTextPlugin();

    await expect(
      runSend({
        params: {
          channel: "slack",
          message: "do not deliver to a session key",
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:agent:main:main",
        },
        sessionKey: "agent:main:subagent:worker",
      }),
    ).rejects.toThrow(/requires a target/i);

    expect(sendText).not.toHaveBeenCalled();
  });

  it("delivers to a real current conversation instead of an internal session channel", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runSend({
      params: {
        channel: "slack",
        message: "deliver to the actual conversation",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "agent:main:subagent:worker",
        currentMessagingTarget: "channel:C123",
      },
      sessionKey: "agent:main:subagent:worker",
    });

    expect(result).toMatchObject({ kind: "send", channel: "slack", to: "channel:C123" });
    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      to: "channel:C123",
      text: "deliver to the actual conversation",
    });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("preserves required delivery when message-tool-only sends target another conversation", async () => {
    const sendText = registerSlackTextPlugin();

    await expect(
      runSourceSend({
        params: {
          target: "channel:C999",
          message: "explicit durable send",
          bestEffort: false,
        },
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("preserves required delivery when message-tool-only sends to another explicit channel", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "telegram",
      messageId: "m1",
      chatId: "C999",
    });
    registerPlugin({
      id: "telegram",
      outbound: { deliveryMode: "direct", sendText },
    });

    await expect(
      runSourceSend({
        cfg: {
          channels: { telegram: { enabled: true } },
          tools: { message: { crossContext: { allowAcrossProviders: true } } },
        } as OpenClawConfig,
        params: {
          channel: "telegram",
          message: "explicit channel-only durable send",
          bestEffort: false,
        },
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });
});
