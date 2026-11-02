import { beforeEach, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { sanitizeProviderReplayHistoryWithPluginAsync } from "./provider-replay-runtime.js";

const { resolveProviderRuntimePlugin } = vi.hoisted(() => ({
  resolveProviderRuntimePlugin:
    vi.fn<typeof import("./provider-hook-runtime.js").resolveProviderRuntimePlugin>(),
}));
vi.mock("./provider-hook-runtime.js", () => ({ resolveProviderRuntimePlugin }));
beforeEach(() => resolveProviderRuntimePlugin.mockReset());

it("prefers the awaited replay hook and never retries failures through its legacy adapter", async () => {
  const legacy = vi.fn(() => []);
  const awaited = vi.fn(async () => {
    throw new Error("worker replay write failed");
  });
  resolveProviderRuntimePlugin.mockReturnValue({
    id: "demo",
    label: "Demo",
    auth: [],
    sanitizeReplayHistory: legacy,
    sanitizeReplayHistoryAsync: awaited,
  });
  await expect(
    sanitizeProviderReplayHistoryWithPluginAsync({
      provider: "demo",
      context: { provider: "demo", sessionId: "replay-failure", messages: [] },
    }),
  ).rejects.toThrow("worker replay write failed");
  expect(legacy).not.toHaveBeenCalled();
});

it("retains the deprecated third-party replay hook when no awaited hook is provided", async () => {
  const messages: AgentMessage[] = [{ role: "user", content: "sanitized", timestamp: 1 }];
  const legacy = vi.fn(() => messages);
  resolveProviderRuntimePlugin.mockReturnValue({
    id: "demo",
    label: "Demo",
    auth: [],
    sanitizeReplayHistory: legacy,
  });
  expect(
    await sanitizeProviderReplayHistoryWithPluginAsync({
      provider: "demo",
      context: { provider: "demo", sessionId: "replay-legacy", messages: [] },
    }),
  ).toEqual(messages);
});
