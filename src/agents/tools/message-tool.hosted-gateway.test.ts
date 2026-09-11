import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  createGatewayActionPlugin,
  messageActionRunnerMocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin,
} from "../../infra/outbound/message-action-runner.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

const hoistedGatewayToolMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  configState: {
    value: {} as Record<string, unknown>,
  },
  deviceIdentity: {
    deviceId: "agent-tool-device",
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
  },
  persistedDeviceIdentity: undefined as
    | {
        deviceId: string;
        publicKeyPem: string;
        privateKeyPem: string;
      }
    | null
    | undefined,
  deviceIdentityError: undefined as Error | undefined,
}));
const mocks = hoistedGatewayToolMocks;
const testDelegatedAuthorities: AgentRunDelegatedAuthority[] = [];

function releaseTestDelegatedAuthorities(): void {
  for (const authority of testDelegatedAuthorities.splice(0)) {
    releaseAgentRunDelegatedAuthority(authority);
  }
}
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => mocks.configState.value,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));
vi.mock("../../infra/device-identity.js", () => ({
  loadDeviceIdentityIfPresent: () =>
    mocks.persistedDeviceIdentity === undefined
      ? mocks.deviceIdentity
      : mocks.persistedDeviceIdentity,
  loadOrCreateDeviceIdentity: () => {
    if (mocks.deviceIdentityError) {
      throw mocks.deviceIdentityError;
    }
    return mocks.deviceIdentity;
  },
}));

function testGatewayCaller(
  identity: Omit<
    NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>,
    "operationalRunInstance"
  >,
): NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]> {
  const operationalRunInstance = createOperationalRunInstanceRef("run-gateway-tool-test");
  testDelegatedAuthorities.push(claimAgentRunDelegatedAuthority(operationalRunInstance));
  const context = { getRuntimeConfig: () => mocks.configState.value } as GatewayRequestContext;
  return {
    gatewayContextResolver: () => context,
    ...identity,
    operationalRunInstance,
  };
}

describe("hosted message-tool routing", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
  };

  beforeEach(() => {
    releaseTestDelegatedAuthorities();
    mocks.callGateway.mockReset();
    mocks.deviceIdentityError = undefined;
    mocks.persistedDeviceIdentity = undefined;
    mocks.configState.value = {};
    setActivePluginRegistry(createEmptyPluginRegistry());
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  afterAll(() => {
    releaseTestDelegatedAuthorities();
    if (envSnapshot.openclaw === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = envSnapshot.openclaw;
    }
    if (envSnapshot.gatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = envSnapshot.gatewayUrl;
    }
  });

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
