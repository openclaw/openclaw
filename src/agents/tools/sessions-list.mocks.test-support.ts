import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

// mock-isolation: Projection fixtures must not initialize or dispatch to a real Gateway.
vi.mock("./in-process-gateway.js", () => ({
  hasGatewayToolRoutingContext: () => false,
  getInProcessGatewayToolContext: () => undefined,
  callAgentToolGatewayRequest: (opts: unknown) => mocks.gatewayCall(opts),
}));

// mock-isolation: Version fixtures must not read or subscribe to real session state.
vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
}));

export { mocks };
