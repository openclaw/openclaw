import { beforeEach, expect, it, vi } from "vitest";
import { sanitizeProviderReplayHistoryWithPluginAsync } from "./provider-replay-runtime.js";

const { resolveProviderRuntimePlugin } = vi.hoisted(() => ({
  resolveProviderRuntimePlugin:
    vi.fn<typeof import("./provider-hook-runtime.js").resolveProviderRuntimePlugin>(),
}));
vi.mock("./provider-hook-runtime.js", () => ({ resolveProviderRuntimePlugin }));
beforeEach(() => resolveProviderRuntimePlugin.mockReset());

it("propagates worker-backed replay hook failures", async () => {
  const awaited = vi.fn(async () => {
    throw new Error("worker replay write failed");
  });
  resolveProviderRuntimePlugin.mockReturnValue({
    id: "demo",
    label: "Demo",
    auth: [],
    sanitizeReplayHistoryAsync: awaited,
  });
  await expect(
    sanitizeProviderReplayHistoryWithPluginAsync({
      provider: "demo",
      context: { provider: "demo", sessionId: "replay-failure", messages: [] },
    }),
  ).rejects.toThrow("worker replay write failed");
});
