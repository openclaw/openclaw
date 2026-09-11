import { afterAll, beforeEach, expect, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

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
export const mocks = hoistedGatewayToolMocks;
const testDelegatedAuthorities: AgentRunDelegatedAuthority[] = [];

export function releaseTestDelegatedAuthorities(): void {
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

export function capturedGatewayCall(): CallGatewayOptions {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  const call = mocks.callGateway.mock.calls[0];
  if (!call) {
    throw new Error("expected callGateway to be called");
  }
  return call[0] as CallGatewayOptions;
}

export function testGatewayCaller(
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

export function installGatewayToolTestHooks(): void {
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
}
