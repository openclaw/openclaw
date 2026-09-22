import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type ThreadBindingsRuntime = PluginRuntime["channel"]["threadBindings"];

export function createPluginThreadBindingsRuntimeMock(): ThreadBindingsRuntime {
  return {
    setIdleTimeoutBySessionKeyAsync:
      vi.fn<ThreadBindingsRuntime["setIdleTimeoutBySessionKeyAsync"]>(),
    setMaxAgeBySessionKeyAsync: vi.fn<ThreadBindingsRuntime["setMaxAgeBySessionKeyAsync"]>(),
    setIdleTimeoutBySessionKey: vi.fn<ThreadBindingsRuntime["setIdleTimeoutBySessionKey"]>(),
    setMaxAgeBySessionKey: vi.fn<ThreadBindingsRuntime["setMaxAgeBySessionKey"]>(),
  };
}
