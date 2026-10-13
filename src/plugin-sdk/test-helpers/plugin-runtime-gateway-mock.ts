import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginGatewayRuntimeMock(): PluginRuntime["gateway"] {
  return {
    isAvailable: vi.fn(async () => false),
    request: vi.fn(),
    openPluginPanel: vi.fn<PluginRuntime["gateway"]["openPluginPanel"]>(async () => ({ ok: true })),
    readSessionFacts: vi.fn<PluginRuntime["gateway"]["readSessionFacts"]>(async () => ({
      sessions: [],
    })),
    withSessionFacts: async (_select, run) =>
      run({ scope: undefined, revision: "mock", sessions: [] }),
    subscribeSessionChanges: vi.fn(() => () => {}),
  };
}
