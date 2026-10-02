import { afterEach, beforeEach, vi } from "vitest";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { mocks, type MockNodeConfig } from "./nodes.invoke-wake-mocks.test-support.js";
import { createNodeInvokeTestHarness } from "./nodes.invoke.test-support.js";
import { nodeHandlers } from "./nodes.js";

export { mocks, type MockNodeConfig };

export type WakeResultOverrides = Partial<{
  ok: boolean;
  status: number;
  reason: string;
  tokenSuffix: string;
  topic: string;
  environment: "sandbox" | "production";
  transport: "direct" | "relay";
}>;

export function directRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "direct" as const,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox" as const,
    updatedAtMs: 1,
  };
}

export const DIRECT_APNS_AUTH = {
  ok: true,
  value: {
    teamId: "TEAM123",
    keyId: "KEY123",
    privateKey: "synthetic-apns-auth-placeholder",
  },
} as const;
export const DIRECT_APNS_RESULT = {
  ok: true,
  status: 200,
  tokenSuffix: "1234abcd",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  transport: "direct",
} as const;

export function mockDirectWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue(DIRECT_APNS_AUTH);
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ...DIRECT_APNS_RESULT,
    ...overrides,
  });
}

export const invokeNode = createNodeInvokeTestHarness({
  getRuntimeConfig: () => mocks.getRuntimeConfig(),
  nodeHandlers,
});

export function createMissingNodeRegistry() {
  return {
    get: vi.fn(() => undefined),
    invoke: vi.fn().mockResolvedValue({ ok: true }),
  };
}

export function installNodeInvokeWakeFixture() {
  beforeEach(() => {
    resetNodeWakeStateForTest();
    mocks.captureNodePairingGeneration.mockReset().mockImplementation(async (nodeId: string) => ({
      nodeId,
      key: `generation:${nodeId}:1`,
    }));
    mocks.getRuntimeConfig.mockClear();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set());
    mocks.isNodeCommandAllowed.mockClear();
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.isForegroundRestrictedPluginNodeCommand.mockClear();
    mocks.isForegroundRestrictedPluginNodeCommand.mockImplementation((command: string) =>
      command.startsWith("canvas."),
    );
    mocks.isNodePairingGenerationCurrent.mockReset().mockResolvedValue(true);
    mocks.sanitizeNodeInvokeParamsForForwarding.mockClear();
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => ({ ok: true, params: rawParams }),
    );
    mocks.loadApnsRegistration.mockClear();
    mocks.clearApnsRegistrationIfCurrent.mockClear();
    mocks.resolveApnsAuthConfigFromEnv.mockClear();
    mocks.resolveApnsRelayConfigFromEnv.mockClear();
    mocks.sendApnsBackgroundWake.mockClear();
    mocks.sendApnsAlert.mockClear();
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}
