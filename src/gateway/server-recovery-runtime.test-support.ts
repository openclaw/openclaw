import { vi } from "vitest";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";

export function createMockGatewayRecoveryRuntime(
  overrides: Partial<GatewayRecoveryRuntime> = {},
): GatewayRecoveryRuntime {
  return {
    prepareRestartRecovery: vi.fn(() => undefined),
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
    ...overrides,
  };
}

export function captureRecoveryTarget(
  storePath: string,
  sessionKey: string,
  sessionId: string,
  agentId = "main",
) {
  return captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    incarnation: sessionId,
    agentId,
  });
}
