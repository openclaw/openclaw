import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginSystemRuntimeMock(): PluginRuntime["system"] {
  return {
    captureSessionEventTarget: vi
      .fn<PluginRuntime["system"]["captureSessionEventTarget"]>()
      .mockImplementation(
        async () =>
          Object.freeze({}) as Awaited<
            ReturnType<PluginRuntime["system"]["captureSessionEventTarget"]>
          >,
      ),
    enqueueSessionEvent: vi
      .fn<PluginRuntime["system"]["enqueueSessionEvent"]>()
      .mockImplementation(() => ({
        id: "test-session-event",
        cancel: () => false,
        settled: Promise.resolve({
          status: "completed",
          executionStarted: true,
          delivered: false,
        }),
      })),
    enqueueSystemEvent: vi.fn<PluginRuntime["system"]["enqueueSystemEvent"]>(),
    runCommandWithTimeout: vi.fn<PluginRuntime["system"]["runCommandWithTimeout"]>(),
    formatNativeDependencyHint: vi.fn<PluginRuntime["system"]["formatNativeDependencyHint"]>(
      () => "",
    ),
  };
}
