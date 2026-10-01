import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginGatewayRuntimeMock(): PluginRuntime["gateway"] {
  return {
    isAvailable: vi.fn(async () => false),
    request: vi.fn(),
    readSessionFacts: vi.fn<PluginRuntime["gateway"]["readSessionFacts"]>(async () => ({
      sessions: [],
    })),
  };
}
