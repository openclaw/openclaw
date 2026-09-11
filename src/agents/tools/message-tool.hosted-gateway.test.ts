// Register Gateway mocks before importing runtime dependencies.
import "./gateway.test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import {
  createGatewayActionPlugin,
  messageActionRunnerMocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin,
} from "../../infra/outbound/message-action-runner.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  installGatewayToolTestHooks,
  mocks,
  releaseTestDelegatedAuthorities,
  testGatewayCaller,
} from "./gateway.test-helpers.js";
import { createMessageTool } from "./message-tool-execution.js";

describe("hosted message-tool routing", () => {
  installGatewayToolTestHooks();

  it("keeps hosted message-tool actions on the prepared local connection", async () => {
    resetMessageActionRunnerMocks();
    const plugin = createGatewayActionPlugin({
      pluginId: "gatewaychat",
      label: "Gateway Chat",
      blurb: "Hosted Gateway routing fixture.",
      actions: ["react"],
      capabilities: { chatTypes: ["direct"], reactions: true },
      handleAction: vi.fn(async () => ({ content: [], details: {} })),
    });
    setMessageActionTestPlugin(plugin, "gatewaychat");
    mocks.configState.value = {
      gateway: {
        mode: "remote",
        port: 18789,
        remote: { url: "wss://primary.example" },
      },
      channels: { gatewaychat: { enabled: true } },
    };
    process.env.OPENCLAW_GATEWAY_URL = "wss://environment.example";
    const sessionKey = "agent:ops:gatewaychat:direct:alice";
    const runId = "run-gateway-tool-test";
    const turnCapability = mintMessageActionTurnCapability({ agentId: "ops", runId, sessionKey });
    const caller = testGatewayCaller({ agentId: "ops", sessionKey });
    const tool = createMessageTool({
      getRuntimeConfig: () => mocks.configState.value,
      runMessageAction,
      agentId: "ops",
      agentSessionKey: sessionKey,
      runId,
      messageActionTurnCapability: turnCapability,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    const execute = () =>
      withGatewayToolCallerIdentity(caller, () =>
        tool.execute("hosted-reaction", {
          action: "react",
          channel: "gatewaychat",
          target: "alice",
          messageId: "message-1",
          emoji: "✅",
        }),
      );
    messageActionRunnerMocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });
    try {
      await execute();
      expect(messageActionRunnerMocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
      expect(messageActionRunnerMocks.callGatewayLeastPrivilege).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "message.action",
          config: mocks.configState.value,
          localPortOverride: 18789,
          ignoreEnvUrlOverride: true,
          url: undefined,
          agentRuntimeIdentityToken: expect.any(String),
        }),
      );
      releaseTestDelegatedAuthorities();
      messageActionRunnerMocks.callGatewayLeastPrivilege.mockClear();
      await expect(execute()).rejects.toThrow(
        "agent runtime identity requires active delegated run authority",
      );
      expect(messageActionRunnerMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    } finally {
      revokeMessageActionTurnCapability(turnCapability);
    }
  });
});
