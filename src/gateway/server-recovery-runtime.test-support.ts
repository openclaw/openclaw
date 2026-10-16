import { vi } from "vitest";
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
