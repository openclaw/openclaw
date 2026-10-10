import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginStateRuntimeMock(): PluginRuntime["state"] {
  return {
    resolveStateDir: vi.fn(() => "/tmp/openclaw"),
    openBlobStore: vi.fn(() => {
      throw new Error("openBlobStore mock is not configured");
    }),
    openKeyedStore: vi.fn(() => {
      throw new Error("openKeyedStore mock is not configured");
    }),
    openSyncKeyedStore: vi.fn(() => {
      throw new Error("openSyncKeyedStore mock is not configured");
    }),
    openChannelIngressQueue: vi.fn(() => {
      throw new Error("openChannelIngressQueue mock is not configured");
    }),
    openChannelIngressDrain: vi.fn(() => {
      throw new Error("openChannelIngressDrain mock is not configured");
    }),
  };
}
