import { describe, expect, it, vi } from "vitest";

const mockedRegistryAdapter = vi.hoisted<{ value: unknown }>(() => ({ value: undefined }));
const mockedBundledAdapter = vi.hoisted<{ value: unknown }>(() => ({ value: undefined }));

vi.mock("../registry-loader.js", () => ({
  createChannelRegistryLoader: () => async () => mockedRegistryAdapter.value,
}));

vi.mock("../bundled.js", () => ({
  getBundledChannelPlugin: vi.fn((id: string) =>
    id === "discord" && mockedBundledAdapter.value
      ? { outbound: mockedBundledAdapter.value }
      : undefined,
  ),
}));

const { loadChannelOutboundAdapter } = await import("./load.js");

describe("loadChannelOutboundAdapter", () => {
  it("falls back to bundled channel outbound adapters when the active registry is missing channel plugins", async () => {
    const bundledAdapter = { sendText: vi.fn() };
    mockedRegistryAdapter.value = undefined;
    mockedBundledAdapter.value = bundledAdapter;

    await expect(loadChannelOutboundAdapter("discord")).resolves.toBe(bundledAdapter);
  });
});
