import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessageToolDiscoveryAdapter } from "./message-tool-api.js";
import type { ChannelMessageActionDiscoveryContext } from "./types.core.js";

const { defaultRuntimeMock } = vi.hoisted(() => ({
  defaultRuntimeMock: { error: vi.fn() },
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: defaultRuntimeMock,
}));

describe("message action discovery error cache", () => {
  beforeEach(() => {
    defaultRuntimeMock.error.mockClear();
    vi.resetModules();
  });

  it("caps the error dedupe cache at 1024 entries and re-logs evicted errors", async () => {
    const { resolveMessageActionDiscoveryForPlugin } =
      await import("./message-action-discovery.js");

    const describeMessageTool = vi.fn();
    const actions = {
      describeMessageTool,
    } as unknown as ChannelMessageToolDiscoveryAdapter;
    const context = { cfg: {} } as unknown as ChannelMessageActionDiscoveryContext;

    for (let i = 0; i < 1024; i++) {
      describeMessageTool.mockImplementationOnce(() => {
        throw new Error(`error-${i}`);
      });
      resolveMessageActionDiscoveryForPlugin({
        pluginId: "test-plugin",
        actions,
        context,
      });
    }
    expect(defaultRuntimeMock.error).toHaveBeenCalledTimes(1024);

    // Push the cache over its max size; the oldest entry (error-0) is evicted.
    describeMessageTool.mockImplementationOnce(() => {
      throw new Error("error-1024");
    });
    resolveMessageActionDiscoveryForPlugin({
      pluginId: "test-plugin",
      actions,
      context,
    });
    expect(defaultRuntimeMock.error).toHaveBeenCalledTimes(1025);

    // The evicted error should be logged again because it is no longer cached.
    describeMessageTool.mockImplementationOnce(() => {
      throw new Error("error-0");
    });
    resolveMessageActionDiscoveryForPlugin({
      pluginId: "test-plugin",
      actions,
      context,
    });
    expect(defaultRuntimeMock.error).toHaveBeenCalledTimes(1026);
  });
});
